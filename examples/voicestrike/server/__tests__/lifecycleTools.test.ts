import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandBus, COMMAND_TIMEOUT_MS } from '../commandBus.js';
import type { ServerResponse } from 'node:http';

function makeStream(writeFn?: (data: string) => void): ServerResponse {
  return {
    write: (data: string) => { writeFn?.(data); return true; },
    writableEnded: false,
  } as unknown as ServerResponse;
}

describe('CommandBus lifecycle commands', () => {
  let bus: CommandBus;

  beforeEach(() => {
    bus = new CommandBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Dispatch tests ──────────────────────────────────────────────────────────

  it('dispatches pause command and resolves when browser responds', async () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch1', stream);

    const dispatchPromise = bus.dispatch('ch1', 'pause', '', 'cmd-pause-1');

    // Verify the SSE payload was written
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]!.replace('data: ', '').trim());
    expect(payload.action).toBe('pause');
    expect(payload.id).toBe('cmd-pause-1');
    // No weaponId for lifecycle commands
    expect(payload.weaponId).toBeUndefined();

    bus.resolveCommand('cmd-pause-1', { ok: true, message: 'Game paused' });
    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Game paused');
  });

  it('dispatches resume command without weaponId', async () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch1', stream);

    const dispatchPromise = bus.dispatch('ch1', 'resume', '', 'cmd-resume-1');

    const payload = JSON.parse(written[0]!.replace('data: ', '').trim());
    expect(payload.action).toBe('resume');
    expect(payload.weaponId).toBeUndefined();

    bus.resolveCommand('cmd-resume-1', { ok: true, message: 'Game resumed' });
    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
  });

  it('dispatches restart command without weaponId', async () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch1', stream);

    const dispatchPromise = bus.dispatch('ch1', 'restart', '', 'cmd-restart-1');

    const payload = JSON.parse(written[0]!.replace('data: ', '').trim());
    expect(payload.action).toBe('restart');
    expect(payload.weaponId).toBeUndefined();

    bus.resolveCommand('cmd-restart-1', { ok: true, message: 'Game restarted' });
    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
  });

  it('dispatches stop command without weaponId', async () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch1', stream);

    const dispatchPromise = bus.dispatch('ch1', 'stop', '', 'cmd-stop-1');

    const payload = JSON.parse(written[0]!.replace('data: ', '').trim());
    expect(payload.action).toBe('stop');
    expect(payload.weaponId).toBeUndefined();

    bus.resolveCommand('cmd-stop-1', { ok: true, message: 'Game stopped' });
    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
  });

  // ── notify() tests ──────────────────────────────────────────────────────────

  it('notify() sends a named SSE event to the channel stream', () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch2', stream);

    bus.notify('ch2', 'highlight', { weaponIds: ['shotgun'], area: 'armory' });

    expect(written).toHaveLength(1);
    const raw = written[0]!;
    expect(raw).toContain('event: highlight\n');
    expect(raw).toContain('data: ');
    const dataLine = raw.split('\n').find(l => l.startsWith('data: '))!;
    const data = JSON.parse(dataLine.replace('data: ', ''));
    expect(data.weaponIds).toEqual(['shotgun']);
    expect(data.area).toBe('armory');
  });

  it('notify() is a no-op when no stream is registered', () => {
    // Should not throw
    expect(() => bus.notify('no-such-channel', 'highlight', {})).not.toThrow();
  });

  it('notify() is a no-op when stream has ended', () => {
    const endedStream = {
      write: vi.fn(),
      writableEnded: true,
    } as unknown as ServerResponse;
    bus.registerStream('ch3', endedStream);

    bus.notify('ch3', 'highlight', { weaponIds: [] });
    expect(endedStream.write).not.toHaveBeenCalled();
  });

  // ── Session cleanup ─────────────────────────────────────────────────────────

  it('pending command times out when COMMAND_TIMEOUT_MS elapses', async () => {
    const stream = makeStream();
    bus.registerStream('ch4', stream);

    const dispatchPromise = bus.dispatch('ch4', 'pause', '', 'cmd-timeout-1');

    // Advance timers past the timeout
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 100);

    const result = await dispatchPromise;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('stale command ID cannot be resolved after restart (new command ID)', async () => {
    const stream = makeStream();
    bus.registerStream('ch5', stream);

    // Start a command but let it time out (simulating a stale session)
    const dispatchPromise = bus.dispatch('ch5', 'restart', '', 'old-cmd-id');
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 100);
    await dispatchPromise; // consume the timed-out promise

    // Trying to resolve the old ID after timeout should return false
    const resolved = bus.resolveCommand('old-cmd-id', { ok: true, message: 'too late' });
    expect(resolved).toBe(false);
  });

  // ── In-flight guard ─────────────────────────────────────────────────────────

  it('in-flight guard rejects duplicate lifecycle command while one is pending', async () => {
    const stream = makeStream();
    bus.registerStream('ch6', stream);

    // Start the first pause — do not resolve yet
    const first = bus.dispatch('ch6', 'pause', '', 'cmd-pause-a');

    // Attempt a second pause for the same channel
    const second = await bus.dispatch('ch6', 'pause', '', 'cmd-pause-b');

    expect(second.ok).toBe(false);
    expect(second.message).toContain('already in progress');

    // Clean up first
    bus.resolveCommand('cmd-pause-a', { ok: true, message: 'paused' });
    await first;
  });

  it('in-flight guard lifts after first lifecycle command resolves', async () => {
    const written: string[] = [];
    const stream = makeStream(d => written.push(d));
    bus.registerStream('ch7', stream);

    // First pause
    const first = bus.dispatch('ch7', 'pause', '', 'cmd-p1');
    bus.resolveCommand('cmd-p1', { ok: true, message: 'paused' });
    await first;

    // Second pause should now be accepted
    const second = bus.dispatch('ch7', 'pause', '', 'cmd-p2');
    bus.resolveCommand('cmd-p2', { ok: true, message: 'paused again' });
    const result = await second;

    expect(result.ok).toBe(true);
    expect(written).toHaveLength(2);
  });

  it('returns no-stream error for lifecycle command when stream is absent', async () => {
    // No stream registered for this channel
    const result = await bus.dispatch('ghost-channel', 'resume');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No active game session');
  });
});
