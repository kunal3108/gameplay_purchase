import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export type CommandAction = 'purchase' | 'equip';

export interface VoiceCommand {
  id: string;        // used as CommerceEngine idempotency key (= tool_call_id when available)
  action: CommandAction;
  weaponId: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

/** How long (ms) the tool endpoint waits for the browser before giving up. */
export const COMMAND_TIMEOUT_MS = 4_000; // Agora tool timeout is 5 000 ms — leaves 1 s buffer

interface PendingEntry {
  resolve: (result: CommandResult) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * Routes commands from Agora tool endpoints to the browser via SSE,
 * collects results, and enforces idempotency for concurrent calls.
 *
 * One singleton per server process (exported as `commandBus`).
 */
export class CommandBus {
  /** Active SSE streams keyed by channel. */
  private readonly streams = new Map<string, ServerResponse>();

  /** Tool calls waiting for a browser result: commandId → entry. */
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * In-flight set: `${channel}:${action}:${weaponId}`.
   * Prevents two concurrent dispatches for the same (channel, action, weapon)
   * from both reaching the browser and racing into CommerceEngine.
   */
  private readonly inFlight = new Set<string>();

  // ─── Stream management ────────────────────────────────────────────────────

  /**
   * Register an active SSE `res` for `channel`.
   * Returns a cleanup function; call it when the client disconnects.
   */
  registerStream(channel: string, res: ServerResponse): () => void {
    this.streams.set(channel, res);
    return () => {
      if (this.streams.get(channel) === res) {
        this.streams.delete(channel);
      }
    };
  }

  /** Whether a live SSE stream exists for `channel`. */
  hasStream(channel: string): boolean {
    return this.streams.has(channel);
  }

  /** Number of active SSE streams (for diagnostics). */
  streamCount(): number {
    return this.streams.size;
  }

  /** Number of pending commands (for diagnostics). */
  pendingCount(): number {
    return this.pending.size;
  }

  // ─── Command dispatch ─────────────────────────────────────────────────────

  /**
   * Dispatch a command to the browser.
   *
   * @param channel  - Session channel (must have an active SSE stream).
   * @param action   - 'purchase' | 'equip'
   * @param weaponId - Weapon catalogue ID.
   * @param commandId - Stable ID for this invocation (use Agora's tool_call_id
   *   when available so CommerceEngine idempotency survives Agora retries).
   *   Falls back to a fresh UUID.
   */
  async dispatch(
    channel: string,
    action: CommandAction,
    weaponId: string,
    commandId: string = randomUUID(),
  ): Promise<CommandResult> {
    const stream = this.streams.get(channel);
    if (!stream || stream.writableEnded) {
      return { ok: false, message: 'No active game session for this channel' };
    }

    // Concurrency guard: reject a second identical in-flight request rather than
    // dispatching two commands that race into CommerceEngine.
    const inFlightKey = `${channel}:${action}:${weaponId}`;
    if (this.inFlight.has(inFlightKey)) {
      return { ok: false, message: 'Command already in progress — please wait a moment' };
    }
    this.inFlight.add(inFlightKey);

    try {
      return await this._sendAndWait(stream, commandId, action, weaponId);
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private _sendAndWait(
    stream: ServerResponse,
    commandId: string,
    action: CommandAction,
    weaponId: string,
  ): Promise<CommandResult> {
    const cmd: VoiceCommand = { id: commandId, action, weaponId };

    return new Promise<CommandResult>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(commandId);
        resolve({ ok: false, message: 'Command timed out — game did not respond in time' });
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(commandId, { resolve, timeoutHandle });

      try {
        stream.write(`data: ${JSON.stringify(cmd)}\n\n`);
      } catch {
        clearTimeout(timeoutHandle);
        this.pending.delete(commandId);
        resolve({ ok: false, message: 'Failed to deliver command to game session' });
      }
    });
  }

  // ─── Result delivery ──────────────────────────────────────────────────────

  /**
   * Deliver a result from the browser for a pending command.
   * @returns `true` if the command was found and resolved; `false` if it had
   *   already timed out or never existed.
   */
  resolveCommand(commandId: string, result: CommandResult): boolean {
    const entry = this.pending.get(commandId);
    if (!entry) return false;
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(commandId);
    entry.resolve(result);
    return true;
  }
}

export const commandBus = new CommandBus();
