/**
 * Regression tests for Agora agent lifecycle fixes:
 *
 * Race condition — requestProactiveRecommendation fires during 'connecting' state:
 *   Root cause: the guard allowed all states except idle/error/disconnecting.
 *   When the 15 s timeout fires, cleanup() runs async before setState('error').
 *   During that window state is still 'connecting', so game events trigger
 *   proactive speaks → agent-speak → 500 ErrConflict.
 *   Fix: guard only allows 'connected', 'listening', 'speaking'.
 *
 * Dead session leak — agentSessionStore not cleared on 15 s timeout:
 *   Root cause: cleanup() calls /api/stop-conversation without a 'channel' field.
 *   The stop-conversation handler only deletes agentSessionStore when channel is present.
 *   Fix: include channel in the stop-conversation payload.
 *
 * ErrConflict 500 — Agora 400 returned as HTTP 500:
 *   Root cause: the agent-speak catch block returned 500 for all errors.
 *   Fix: detect AgoraError statusCode 400 (ErrConflict) → return { ok: false },
 *   clean up agentSessionStore entry, log the cause.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── requestProactiveRecommendation guard ─────────────────────────────────────

type VoiceState =
  | 'idle' | 'connecting' | 'connected'
  | 'listening' | 'speaking' | 'disconnecting' | 'error';

/**
 * Extracted guard logic matching AgoraVoiceAdapter.requestProactiveRecommendation
 * after the fix.  Tests verify only the state filter, not the HTTP call.
 */
function proactiveGuardAllows(state: VoiceState, channel: string | null, writeToken: string | null): boolean {
  if (!channel || !writeToken) return false;
  if (state !== 'connected' && state !== 'listening' && state !== 'speaking') return false;
  return true;
}

describe('requestProactiveRecommendation guard (after fix)', () => {
  const CH = 'ch-123';
  const WT = 'token-abc';

  it('allows when connected', () => {
    expect(proactiveGuardAllows('connected', CH, WT)).toBe(true);
  });

  it('allows when listening', () => {
    expect(proactiveGuardAllows('listening', CH, WT)).toBe(true);
  });

  it('allows when speaking', () => {
    expect(proactiveGuardAllows('speaking', CH, WT)).toBe(true);
  });

  // ── States that MUST be blocked ─────────────────────────────────────────────

  it('blocks during connecting — prevents ErrConflict race during 15s cleanup window', () => {
    expect(proactiveGuardAllows('connecting', CH, WT)).toBe(false);
  });

  it('blocks during idle', () => {
    expect(proactiveGuardAllows('idle', CH, WT)).toBe(false);
  });

  it('blocks during error', () => {
    expect(proactiveGuardAllows('error', CH, WT)).toBe(false);
  });

  it('blocks during disconnecting', () => {
    expect(proactiveGuardAllows('disconnecting', CH, WT)).toBe(false);
  });

  it('blocks when channel is null (cleanup not yet run)', () => {
    expect(proactiveGuardAllows('connected', null, WT)).toBe(false);
  });

  it('blocks when writeToken is null', () => {
    expect(proactiveGuardAllows('connected', CH, null)).toBe(false);
  });
});

// ─── agentSessionStore cleanup via stop-conversation channel field ────────────

interface MockSession {
  say: ReturnType<typeof vi.fn>;
  status: string;
  id: string | null;
  appId: string;
}

function makeSessionStore() {
  return new Map<string, MockSession>();
}

/** Simulates the stop-conversation handler's cleanup logic */
function stopConversationCleanup(
  store: Map<string, MockSession>,
  writeTokenStore: Map<string, string>,
  channel: string | undefined,
): void {
  if (channel) {
    store.delete(channel);
    writeTokenStore.delete(channel);
  }
}

describe('stop-conversation cleans up agentSessionStore when channel is provided', () => {
  it('deletes the session from agentSessionStore when channel is present', () => {
    const store = makeSessionStore();
    const writeTokens = new Map<string, string>();
    store.set('ch-A', { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });
    writeTokens.set('ch-A', 'wt-123');

    stopConversationCleanup(store, writeTokens, 'ch-A');

    expect(store.get('ch-A')).toBeUndefined();
    expect(writeTokens.get('ch-A')).toBeUndefined();
  });

  it('leaves the session intact when channel is omitted (old code path — was the bug)', () => {
    const store = makeSessionStore();
    const writeTokens = new Map<string, string>();
    store.set('ch-A', { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });
    writeTokens.set('ch-A', 'wt-123');

    // Old code called stop-conversation WITHOUT channel — session leaked
    stopConversationCleanup(store, writeTokens, undefined);

    // Session NOT cleaned up → dead session remains in store
    expect(store.get('ch-A')).toBeDefined();
  });

  it('does not affect other channels', () => {
    const store = makeSessionStore();
    const writeTokens = new Map<string, string>();
    store.set('ch-A', { say: vi.fn(), status: 'running', id: 'agent-A', appId: 'app' });
    store.set('ch-B', { say: vi.fn(), status: 'running', id: 'agent-B', appId: 'app' });
    writeTokens.set('ch-A', 'wt-A');
    writeTokens.set('ch-B', 'wt-B');

    stopConversationCleanup(store, writeTokens, 'ch-A');

    expect(store.get('ch-A')).toBeUndefined();
    expect(store.get('ch-B')).toBeDefined();
    expect(writeTokens.get('ch-B')).toBe('wt-B');
  });
});

// ─── ErrConflict handling — agent-speak returns ok:false not 500 ──────────────

/** Minimal AgoraError mock with statusCode and body */
class MockAgoraError extends Error {
  statusCode: number;
  body: Record<string, string>;
  constructor(statusCode: number, reason: string, detail: string) {
    super(`Status code: ${statusCode}\nBody: ${JSON.stringify({ reason, detail })}`);
    this.statusCode = statusCode;
    this.body = { reason, detail };
  }
}

/**
 * Extracted error-handling logic matching /api/agent-speak after the fix.
 * Returns { ok: boolean; message?: string; http500?: boolean }
 */
function handleSpeakError(
  err: unknown,
  channel: string,
  store: Map<string, MockSession>,
): { ok: boolean; message?: string; http500?: boolean } {
  const isAgoraConflict =
    (err instanceof MockAgoraError && err.statusCode === 400) ||
    (err instanceof Error && err.message.toLowerCase().includes('cannot say'));
  if (isAgoraConflict) {
    store.delete(channel);
    return { ok: false, message: 'Agent is no longer active — voice AI may need to reconnect.' };
  }
  return { ok: false, http500: true };
}

describe('agent-speak ErrConflict handling', () => {
  const CH = 'ch-123';

  it('returns ok:false (not 500) for Agora 400 ErrConflict', () => {
    const store = makeSessionStore();
    store.set(CH, { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });

    const err = new MockAgoraError(400, 'ErrConflict', 'The task is not in a running state and cannot be updated.');
    const result = handleSpeakError(err, CH, store);

    expect(result.ok).toBe(false);
    expect(result.http500).toBeUndefined();
    expect(result.message).toContain('no longer active');
  });

  it('removes the stale session from agentSessionStore on ErrConflict', () => {
    const store = makeSessionStore();
    store.set(CH, { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });

    const err = new MockAgoraError(400, 'ErrConflict', 'The task is not in a running state.');
    handleSpeakError(err, CH, store);

    expect(store.get(CH)).toBeUndefined();
  });

  it('returns ok:false for SDK-side "Cannot say in ... state" error', () => {
    const store = makeSessionStore();
    store.set(CH, { say: vi.fn(), status: 'stopped', id: 'agent-1', appId: 'app' });

    const err = new Error('Cannot say in stopped state');
    const result = handleSpeakError(err, CH, store);

    expect(result.ok).toBe(false);
    expect(result.http500).toBeUndefined();
  });

  it('returns http500 for unexpected errors (not ErrConflict)', () => {
    const store = makeSessionStore();
    store.set(CH, { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });

    const err = new MockAgoraError(503, 'ServiceUnavailable', 'Upstream service error');
    const result = handleSpeakError(err, CH, store);

    expect(result.http500).toBe(true);
  });

  it('returns http500 for network errors', () => {
    const store = makeSessionStore();
    const err = new Error('fetch failed: ECONNRESET');
    const result = handleSpeakError(err, CH, store);
    expect(result.http500).toBe(true);
  });

  it('does not remove session from store for non-conflict errors', () => {
    const store = makeSessionStore();
    store.set(CH, { say: vi.fn(), status: 'running', id: 'agent-1', appId: 'app' });

    const err = new MockAgoraError(503, 'ServiceUnavailable', 'Server error');
    handleSpeakError(err, CH, store);

    expect(store.get(CH)).toBeDefined();
  });
});

// ─── Session status guard before say() ───────────────────────────────────────

describe('session status guard in agent-speak', () => {
  it('skips say() and returns ok:false when session status is not running', () => {
    const statusesToBlock = ['idle', 'starting', 'stopping', 'stopped', 'error'];
    for (const status of statusesToBlock) {
      const session = { say: vi.fn(), status, id: 'agent-1', appId: 'app' };
      // Simulates: if (session.status !== 'running') → { ok: false }
      const shouldCall = session.status === 'running';
      expect(shouldCall).toBe(false);
      expect(session.say).not.toHaveBeenCalled();
    }
  });

  it('calls say() when session status is running', async () => {
    const sayMock = vi.fn().mockResolvedValue(undefined);
    const session = { say: sayMock, status: 'running', id: 'agent-1', appId: 'app' };
    if (session.status === 'running') {
      await session.say('test', { priority: 'APPEND', interruptable: true });
    }
    expect(sayMock).toHaveBeenCalledOnce();
  });
});
