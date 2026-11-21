import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CommandBus, COMMAND_TIMEOUT_MS } from '../commandBus.js';
import type { ServerResponse } from 'node:http';

// Minimal fake SSE stream
function makeStream(writeFn?: (data: string) => void): ServerResponse {
  return {
    write: (data: string) => { writeFn?.(data); return true; },
    writableEnded: false,
  } as unknown as ServerResponse;
}

describe('CommandBus', () => {
  let bus: CommandBus;

  beforeEach(() => {
    bus = new CommandBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Stream management ──────────────────────────────────────────────────────

  it('reports no stream before registration', () => {
    expect(bus.hasStream('ch-1')).toBe(false);
    expect(bus.streamCount()).toBe(0);
  });

  it('reports stream after registration', () => {
    bus.registerStream('ch-1', makeStream());
    expect(bus.hasStream('ch-1')).toBe(true);
    expect(bus.streamCount()).toBe(1);
  });

  it('cleanup function removes the stream', () => {
    const cleanup = bus.registerStream('ch-1', makeStream());
    cleanup();
    expect(bus.hasStream('ch-1')).toBe(false);
  });

  it('cleanup only removes the matching stream (handles reconnect)', () => {
    const cleanup1 = bus.registerStream('ch-1', makeStream());
    // Simulate reconnect: a new stream replaces the old one
    bus.registerStream('ch-1', makeStream());
    cleanup1(); // cleaning up old stream should NOT remove the new one
    expect(bus.hasStream('ch-1')).toBe(true);
  });

  // ── Dispatch and resolve ───────────────────────────────────────────────────

  it('resolves when browser posts a result', async () => {
    let sentData = '';
    bus.registerStream('ch-1', makeStream(d => { sentData = d; }));

    const dispatchPromise = bus.dispatch('ch-1', 'equip', 'shotgun', 'cmd-abc');

    // Simulate browser posting result
    const resolved = bus.resolveCommand('cmd-abc', { ok: true, message: 'Shotgun equipped' });
    expect(resolved).toBe(true);

    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Shotgun equipped');
    expect(sentData).toContain('"id":"cmd-abc"');
    expect(sentData).toContain('"action":"equip"');
    expect(sentData).toContain('"weaponId":"shotgun"');
  });

  it('times out when browser does not respond', async () => {
    bus.registerStream('ch-1', makeStream());

    const dispatchPromise = bus.dispatch('ch-1', 'purchase', 'laser', 'cmd-timeout');

    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 1);

    const result = await dispatchPromise;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('resolveCommand returns false for unknown or timed-out command', () => {
    expect(bus.resolveCommand('no-such-id', { ok: true, message: 'x' })).toBe(false);
  });

  it('resolveCommand returns false after timeout has cleared the pending entry', async () => {
    bus.registerStream('ch-1', makeStream());
    const p = bus.dispatch('ch-1', 'equip', 'pistol', 'late-cmd');
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 1);
    await p;
    expect(bus.resolveCommand('late-cmd', { ok: true, message: 'x' })).toBe(false);
  });

  it('returns error when no stream is registered', async () => {
    const result = await bus.dispatch('no-channel', 'equip', 'pistol');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No active game session');
  });

  // ── In-flight concurrency guard ────────────────────────────────────────────

  it('rejects a second concurrent identical dispatch', async () => {
    bus.registerStream('ch-1', makeStream());

    const p1 = bus.dispatch('ch-1', 'purchase', 'shotgun', 'cmd-1');
    const p2 = bus.dispatch('ch-1', 'purchase', 'shotgun', 'cmd-2');

    // Second call should be immediately rejected
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('already in progress');

    // Resolve first
    bus.resolveCommand('cmd-1', { ok: true, message: 'Shotgun purchased' });
    const r1 = await p1;
    expect(r1.ok).toBe(true);
  });

  it('allows a second dispatch after the first completes', async () => {
    bus.registerStream('ch-1', makeStream());

    const p1 = bus.dispatch('ch-1', 'purchase', 'shotgun', 'cmd-a');
    bus.resolveCommand('cmd-a', { ok: true, message: 'done' });
    await p1;

    // Now the in-flight key is cleared — should succeed
    const p2 = bus.dispatch('ch-1', 'purchase', 'shotgun', 'cmd-b');
    bus.resolveCommand('cmd-b', { ok: false, message: 'already_owned' });
    const r2 = await p2;
    expect(r2.message).toBe('already_owned');
  });

  // ── Session isolation ──────────────────────────────────────────────────────

  it('result for channel A does not resolve command on channel B', async () => {
    let dataA = '', dataB = '';
    bus.registerStream('ch-A', makeStream(d => { dataA = d; }));
    bus.registerStream('ch-B', makeStream(d => { dataB = d; }));

    const pA = bus.dispatch('ch-A', 'equip', 'pistol', 'cmd-A');
    const pB = bus.dispatch('ch-B', 'equip', 'pistol', 'cmd-B');

    // Resolve only channel B's command
    bus.resolveCommand('cmd-B', { ok: true, message: 'B equipped' });
    const rB = await pB;
    expect(rB.ok).toBe(true);
    expect(rB.message).toBe('B equipped');

    // Channel A must still be pending — advance timer to expire it
    expect(bus.pendingCount()).toBe(1);
    vi.advanceTimersByTime(COMMAND_TIMEOUT_MS + 1);
    const rA = await pA;
    expect(rA.ok).toBe(false);
    expect(rA.message).toContain('timed out');

    // Both streams received their own SSE data
    expect(dataA).toContain('cmd-A');
    expect(dataB).toContain('cmd-B');
  });

  it('different actions on the same weapon are not blocked by in-flight guard', async () => {
    bus.registerStream('ch-1', makeStream());

    // purchase and equip for same weapon are different in-flight keys
    const pPurchase = bus.dispatch('ch-1', 'purchase', 'shotgun', 'buy-1');
    const pEquip    = bus.dispatch('ch-1', 'equip',    'shotgun', 'eq-1');

    bus.resolveCommand('buy-1', { ok: true, message: 'purchased' });
    bus.resolveCommand('eq-1',  { ok: true, message: 'equipped' });

    const [rP, rE] = await Promise.all([pPurchase, pEquip]);
    expect(rP.ok).toBe(true);
    expect(rE.ok).toBe(true);
  });
});
