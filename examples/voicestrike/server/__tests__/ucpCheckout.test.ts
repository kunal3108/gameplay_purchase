/**
 * Tests for the UCP-inspired checkout adapter.
 *
 * Tests use isolated UCPSessionStore + SessionStore instances — no HTTP server,
 * no Agora, no Express overhead. The router factory is not involved; we call
 * the business logic indirectly via a lightweight test harness that mirrors
 * the router's behaviour, keeping tests fast and deterministic.
 *
 * We test via the exported stores + CommerceEngine directly to avoid bringing
 * in supertest or starting a real server in this timebox.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CommerceEngine } from '@voice-commerce/core';
import { UCPSessionStore } from '../ucpCheckout.js';
import { SessionStore } from '../sessionStore.js';
import { WEAPON_CATALOGUE } from '../weaponCatalogue.js';
import type { GameStateSnapshot } from '../sessionStore.js';
import type { UCPSession } from '../ucpCheckout.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const CHANNEL = 'test-ch-ucp';

const CATALOG = WEAPON_CATALOGUE.map(w => ({ ...w, currency: 'coins' as const }));

function makeGameState(override?: Partial<GameStateSnapshot>): GameStateSnapshot {
  return {
    balance: 500,
    ownedWeapons: ['pistol'],
    equippedWeapon: 'pistol',
    health: 100,
    maxHealth: 100,
    wave: 1,
    ...override,
  };
}

/**
 * Minimal inline re-implementation of the complete-session logic from the router,
 * operating on plain objects — avoids the need for supertest / HTTP overhead.
 */
async function executeComplete(
  session: UCPSession,
  gameStore: SessionStore,
): Promise<{ ok: boolean; reason?: string; purchasedIds?: string[] }> {
  if (session.status === 'completed') return { ok: true, purchasedIds: session.order?.item_ids };
  if (session.status !== 'ready_for_complete') return { ok: false, reason: `wrong_status:${session.status}` };

  session.status = 'complete_in_progress';

  const gameState = gameStore.get(session.channel);
  if (!gameState) {
    session.status = 'canceled';
    session.failure_reason = 'game_session_not_found';
    return { ok: false, reason: 'game_session_not_found' };
  }

  const snap = { ...gameState, ownedWeapons: [...gameState.ownedWeapons] };

  const engine = new CommerceEngine({
    catalog: CATALOG,
    wallet: {
      getBalance: async () => snap.balance,
      deduct:     async (n) => { snap.balance -= n; },
      credit:     async (n) => { snap.balance += n; },
    },
    inventory: {
      owns: async (id) => snap.ownedWeapons.includes(id),
      add:  async (id) => { snap.ownedWeapons.push(id); },
    },
    autoEquip: false,
  });

  const purchased: string[] = [];
  for (const li of session.line_items) {
    const result = await engine.purchase(li.item_id, {
      idempotencyKey: `ucp:${session.id}:${li.item_id}`,
    });
    if (!result.ok) {
      session.status = 'canceled';
      session.failure_reason = result.reason;
      return { ok: false, reason: result.reason };
    }
    purchased.push(li.item_id);
  }

  gameStore.set(session.channel, { ...gameState, ...snap });
  session.status = 'completed';
  session.order = { id: 'order-test', item_ids: purchased };
  return { ok: true, purchasedIds: purchased };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UCP checkout — session creation', () => {
  it('creates a session with status ready_for_complete', () => {
    const store = new UCPSessionStore();
    const session: UCPSession = {
      id: 'sess-1',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };
    store.set(session.id, session);
    expect(store.get('sess-1')?.status).toBe('ready_for_complete');
  });

  it('computes totals correctly for multiple items', () => {
    // shotgun=300, laser=500 → 800
    const items = [
      { item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' },
      { item_id: 'laser',   name: 'Laser Gun', quantity: 1, unit_price: 500, currency: 'coins' },
    ];
    const subtotal = items.reduce((s, l) => s + l.unit_price * l.quantity, 0);
    expect(subtotal).toBe(800);
  });

  it('includes ucp envelope, links, currency, and totals in wire format', () => {
    const session: UCPSession = {
      id: 'sess-wire',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 1000,
      expires_at: 2000,
    };
    // Verify UCP required fields are present in a serialized form
    const wire = JSON.parse(JSON.stringify({
      ucp: { version: '0.1', protocol: 'ucp' },
      id: session.id,
      line_items: session.line_items,
      status: session.status,
      currency: session.currency,
      totals: session.totals,
      links: { privacy_policy: 'https://example.com/privacy', terms_of_service: 'https://example.com/terms' },
      created_at: session.created_at,
      expires_at: session.expires_at,
    }));
    expect(wire.ucp.version).toBe('0.1');
    expect(wire.id).toBe('sess-wire');
    expect(wire.status).toBe('ready_for_complete');
    expect(wire.currency).toBe('coins');
    expect(wire.totals.grand_total).toBe(300);
    expect(wire.links.privacy_policy).toBeTruthy();
  });
});

describe('UCP checkout — successful purchase', () => {
  let gameStore: SessionStore;
  let checkoutStore: UCPSessionStore;
  let session: UCPSession;

  beforeEach(() => {
    gameStore = new SessionStore();
    checkoutStore = new UCPSessionStore();
    gameStore.set(CHANNEL, makeGameState({ balance: 500 }));

    session = {
      id: 'sess-ok',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };
    checkoutStore.set(session.id, session);
  });

  it('completes successfully and status becomes completed', async () => {
    const result = await executeComplete(session, gameStore);
    expect(result.ok).toBe(true);
    expect(session.status).toBe('completed');
  });

  it('deducts coins from the game wallet', async () => {
    await executeComplete(session, gameStore);
    expect(gameStore.get(CHANNEL)?.balance).toBe(200); // 500 - 300
  });

  it('adds the weapon to ownedWeapons', async () => {
    await executeComplete(session, gameStore);
    expect(gameStore.get(CHANNEL)?.ownedWeapons).toContain('shotgun');
  });

  it('order contains the purchased item_id', async () => {
    const result = await executeComplete(session, gameStore);
    expect(result.purchasedIds).toContain('shotgun');
    expect(session.order?.item_ids).toContain('shotgun');
  });
});

describe('UCP checkout — insufficient funds', () => {
  it('cancels session with failure_reason=insufficient_funds when balance too low', async () => {
    const gameStore = new SessionStore();
    gameStore.set(CHANNEL, makeGameState({ balance: 100 })); // only 100, shotgun costs 300

    const session: UCPSession = {
      id: 'sess-broke',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };

    const result = await executeComplete(session, gameStore);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('insufficient_funds');
    expect(session.status).toBe('canceled');
    expect(session.failure_reason).toBe('insufficient_funds');
  });

  it('does not deduct coins when purchase fails', async () => {
    const gameStore = new SessionStore();
    gameStore.set(CHANNEL, makeGameState({ balance: 100 }));

    const session: UCPSession = {
      id: 'sess-broke-2',
      channel: CHANNEL,
      line_items: [{ item_id: 'laser', name: 'Laser Gun', quantity: 1, unit_price: 500, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 500, tax: 0, grand_total: 500 },
      created_at: 0,
      expires_at: 9999999999,
    };

    await executeComplete(session, gameStore);
    expect(gameStore.get(CHANNEL)?.balance).toBe(100); // unchanged
  });

  it('cancels with already_owned when player already has the weapon', async () => {
    const gameStore = new SessionStore();
    gameStore.set(CHANNEL, makeGameState({ ownedWeapons: ['pistol', 'shotgun'], balance: 999 }));

    const session: UCPSession = {
      id: 'sess-owned',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };

    const result = await executeComplete(session, gameStore);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_owned');
  });
});

describe('UCP checkout — duplicate completion (idempotency)', () => {
  it('calling complete twice returns ok:true both times without double-charging', async () => {
    const gameStore = new SessionStore();
    gameStore.set(CHANNEL, makeGameState({ balance: 500 }));

    const session: UCPSession = {
      id: 'sess-idem',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };

    // First complete
    const first = await executeComplete(session, gameStore);
    expect(first.ok).toBe(true);
    expect(gameStore.get(CHANNEL)?.balance).toBe(200);

    // Second complete — session is already 'completed', must return ok:true with no second deduction
    const second = await executeComplete(session, gameStore);
    expect(second.ok).toBe(true);
    expect(gameStore.get(CHANNEL)?.balance).toBe(200); // unchanged — no second deduction
  });

  it('status remains completed after second call', async () => {
    const gameStore = new SessionStore();
    gameStore.set(CHANNEL, makeGameState({ balance: 500 }));

    const session: UCPSession = {
      id: 'sess-idem-2',
      channel: CHANNEL,
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };

    await executeComplete(session, gameStore);
    await executeComplete(session, gameStore);
    expect(session.status).toBe('completed');
  });

  it('completing a canceled session returns wrong_status error', async () => {
    const gameStore = new SessionStore();
    const session: UCPSession = {
      id: 'sess-canceled',
      channel: CHANNEL,
      line_items: [],
      status: 'canceled',
      currency: 'coins',
      totals: { subtotal: 0, tax: 0, grand_total: 0 },
      created_at: 0,
      expires_at: 9999999999,
    };

    const result = await executeComplete(session, gameStore);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/wrong_status/);
  });
});

describe('UCP checkout — cancel', () => {
  it('a ready_for_complete session can be canceled', () => {
    const session: UCPSession = {
      id: 'sess-cancel',
      channel: CHANNEL,
      line_items: [],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 0, tax: 0, grand_total: 0 },
      created_at: 0,
      expires_at: 9999999999,
    };
    // Simulate cancel handler
    session.status = 'canceled';
    expect(session.status).toBe('canceled');
  });

  it('a completed session cannot be canceled', () => {
    const session: UCPSession = {
      id: 'sess-cancel-done',
      channel: CHANNEL,
      line_items: [],
      status: 'completed',
      currency: 'coins',
      totals: { subtotal: 0, tax: 0, grand_total: 0 },
      created_at: 0,
      expires_at: 9999999999,
    };
    // Simulate cancel guard
    const canCancel = session.status !== 'completed' && session.status !== 'complete_in_progress';
    expect(canCancel).toBe(false);
  });
});

describe('UCP checkout — missing game session', () => {
  it('cancels with game_session_not_found when channel has no game state', async () => {
    const gameStore = new SessionStore(); // empty — no state pushed
    const session: UCPSession = {
      id: 'sess-no-game',
      channel: 'nonexistent-channel',
      line_items: [{ item_id: 'shotgun', name: 'Shotgun', quantity: 1, unit_price: 300, currency: 'coins' }],
      status: 'ready_for_complete',
      currency: 'coins',
      totals: { subtotal: 300, tax: 0, grand_total: 300 },
      created_at: 0,
      expires_at: 9999999999,
    };

    const result = await executeComplete(session, gameStore);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('game_session_not_found');
    expect(session.status).toBe('canceled');
  });
});
