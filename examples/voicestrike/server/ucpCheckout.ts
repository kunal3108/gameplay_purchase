/**
 * UCP-inspired Checkout Adapter — VoiceStrike
 *
 * Implements a subset of the Universal Commerce Protocol (UCP) checkout flow:
 *   POST   /api/ucp/checkout-sessions          → create session (ready_for_complete)
 *   GET    /api/ucp/checkout-sessions/:id      → read session state
 *   POST   /api/ucp/checkout-sessions/:id/complete → authorize + execute purchase
 *   POST   /api/ucp/checkout-sessions/:id/cancel   → cancel session
 *
 * UCP status lifecycle (implemented subset):
 *   ready_for_complete → complete_in_progress → completed | canceled
 *
 * LABEL: UCP-inspired, not UCP-compatible.
 * Deviations from spec:
 *   - `currency` is game-coins, not ISO 4217
 *   - `links` are placeholder values (no real legal URLs)
 *   - `payment` on /complete accepts {} (mock game-wallet — no real PSP)
 *   - `ucp.version` is '0.1' (spec does not yet mandate a stable version string)
 *   - `incomplete` status is skipped — sessions start at `ready_for_complete`
 *     because mock game-wallet requires no external payment credentials
 *
 * Reuses:
 *   - CommerceEngine for wallet deduction, idempotency, inventory updates
 *   - SessionStore (passed in) as the live game state source-of-truth
 *   - WEAPON_CATALOGUE for catalog/price lookup
 *   - Existing Agora/Jarvis purchase flow is unchanged
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { CommerceEngine } from '@voice-commerce/core';
import type { SessionStore } from './sessionStore.js';
import { WEAPON_CATALOGUE } from './weaponCatalogue.js';

// ─── UCP types ────────────────────────────────────────────────────────────────

type UCPStatus =
  | 'incomplete'
  | 'ready_for_complete'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled';

export interface UCPLineItem {
  item_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

export interface UCPSession {
  id: string;
  channel: string;
  line_items: UCPLineItem[];
  status: UCPStatus;
  currency: string;
  totals: { subtotal: number; tax: number; grand_total: number };
  created_at: number;
  expires_at: number;
  order?: { id: string; item_ids: string[] };
  failure_reason?: string;
}

// ─── In-memory checkout session store ────────────────────────────────────────

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class UCPSessionStore {
  private readonly sessions = new Map<string, UCPSession>();

  set(id: string, session: UCPSession): void {
    this.sessions.set(id, session);
  }

  get(id: string): UCPSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }
}

// Singleton for server use; tests create their own instances.
export const ucpSessionStore = new UCPSessionStore();

// ─── Wire-format serializer ───────────────────────────────────────────────────

function toWire(session: UCPSession): object {
  return {
    ucp: { version: '0.1', protocol: 'ucp' },
    id: session.id,
    line_items: session.line_items,
    status: session.status,
    currency: session.currency,
    totals: session.totals,
    links: {
      privacy_policy: 'https://example.com/privacy',
      terms_of_service: 'https://example.com/terms',
    },
    created_at: session.created_at,
    expires_at: session.expires_at,
    ...(session.order && { order: session.order }),
    ...(session.failure_reason && { failure_reason: session.failure_reason }),
  };
}

// ─── Catalog mapped to CommerceEngine CatalogItem format ─────────────────────

const CATALOG = WEAPON_CATALOGUE.map(w => ({ ...w, currency: 'coins' as const }));

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * @param gameStore - SessionStore that holds live game state (wallet + inventory)
 * @param checkoutStore - UCPSessionStore for checkout sessions (default: singleton)
 */
export function buildUCPRouter(
  gameStore: SessionStore,
  checkoutStore: UCPSessionStore = ucpSessionStore,
): Router {
  const router = Router();

  // ── POST /checkout-sessions ───────────────────────────────────────────────
  // Creates a checkout session for one or more weapon IDs.
  // Status starts at `ready_for_complete` — mock wallet needs no escalation.
  router.post('/checkout-sessions', (req, res) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { channel, item_ids } = body as { channel?: string; item_ids?: string[] };

      if (!channel || !Array.isArray(item_ids) || item_ids.length === 0) {
        res.status(400).json({ error: 'channel and item_ids[] are required' });
        return;
      }

      const lineItems: UCPLineItem[] = [];
      for (const id of item_ids) {
        const def = WEAPON_CATALOGUE.find(w => w.id === id);
        if (!def) {
          res.status(400).json({ error: `Unknown item_id: "${id}"` });
          return;
        }
        lineItems.push({
          item_id: def.id,
          name: def.name,
          quantity: 1,
          unit_price: def.price,
          currency: 'coins',
        });
      }

      const subtotal = lineItems.reduce((s, l) => s + l.unit_price * l.quantity, 0);
      const now = Date.now();

      const session: UCPSession = {
        id: randomUUID(),
        channel,
        line_items: lineItems,
        status: 'ready_for_complete',
        currency: 'coins',
        totals: { subtotal, tax: 0, grand_total: subtotal },
        created_at: Math.floor(now / 1000),
        expires_at: Math.floor((now + SESSION_TTL_MS) / 1000),
      };

      checkoutStore.set(session.id, session);
      res.status(201).json(toWire(session));
    } catch {
      res.status(400).json({ error: 'Invalid request body' });
    }
  });

  // ── GET /checkout-sessions/:id ────────────────────────────────────────────
  router.get('/checkout-sessions/:id', (req, res) => {
    const session = checkoutStore.get(req.params['id'] ?? '');
    if (!session) {
      res.status(404).json({ error: 'Checkout session not found' });
      return;
    }
    res.json(toWire(session));
  });

  // ── POST /checkout-sessions/:id/complete ──────────────────────────────────
  // Executes the purchase against the game wallet via CommerceEngine.
  // Idempotent: calling complete on an already-completed session returns 200.
  router.post('/checkout-sessions/:id/complete', async (req, res) => {
    const session = checkoutStore.get(req.params['id'] ?? '');
    if (!session) {
      res.status(404).json({ error: 'Checkout session not found' });
      return;
    }

    // Idempotent success
    if (session.status === 'completed') {
      res.json(toWire(session));
      return;
    }

    if (session.status !== 'ready_for_complete') {
      res.status(409).json({
        error: `Cannot complete session in status "${session.status}"`,
        status: session.status,
      });
      return;
    }

    // Advance to in-progress (prevents concurrent double-submit)
    session.status = 'complete_in_progress';

    const gameState = gameStore.get(session.channel);
    if (!gameState) {
      session.status = 'canceled';
      session.failure_reason = 'game_session_not_found';
      res.status(422).json(toWire(session));
      return;
    }

    // Build a mutable snapshot — CommerceEngine mutates wallet/inventory adapters;
    // we write the result back to gameStore only on full success.
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

    const purchasedIds: string[] = [];
    for (const lineItem of session.line_items) {
      const result = await engine.purchase(lineItem.item_id, {
        idempotencyKey: `ucp:${session.id}:${lineItem.item_id}`,
      });
      if (!result.ok) {
        session.status = 'canceled';
        session.failure_reason = result.reason;
        res.status(422).json(toWire(session));
        return;
      }
      purchasedIds.push(lineItem.item_id);
    }

    // Write updated state back — browser will reconcile on next session-state push
    gameStore.set(session.channel, { ...gameState, ...snap });

    session.status = 'completed';
    session.order = { id: randomUUID(), item_ids: purchasedIds };

    res.json(toWire(session));
  });

  // ── POST /checkout-sessions/:id/cancel ────────────────────────────────────
  router.post('/checkout-sessions/:id/cancel', (req, res) => {
    const session = checkoutStore.get(req.params['id'] ?? '');
    if (!session) {
      res.status(404).json({ error: 'Checkout session not found' });
      return;
    }
    if (session.status === 'completed' || session.status === 'complete_in_progress') {
      res.status(409).json({ error: `Cannot cancel session in status "${session.status}"` });
      return;
    }
    session.status = 'canceled';
    res.json(toWire(session));
  });

  return router;
}
