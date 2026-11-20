import { TypedEventEmitter } from "./TypedEventEmitter.js";
import type { CommerceEngineConfig } from "./adapters/CommerceEngineConfig.js";
import type { CatalogItem } from "./types/CatalogItem.js";
import type { PurchaseResult, EquipResult } from "./types/CommerceResult.js";

type CommerceEvents = {
  /** Fires after a successful purchase. newBalance reflects the deducted amount. */
  purchase: [item: CatalogItem, newBalance: number];
  /** Fires whenever the wallet balance changes via the engine. */
  walletChanged: [newBalance: number];
  /** Fires after a successful equip operation (manual or auto-equip). */
  equipped: [item: CatalogItem];
};

const DEFAULT_IDEMPOTENCY_TTL_MS = 30_000;

/**
 * Game-engine-independent commerce SDK.
 *
 * The engine never stores wallet or inventory state itself — it delegates all
 * reads and writes to the adapters you provide, keeping your game the
 * single source of truth.
 *
 * Quick-start:
 *
 *   const engine = new CommerceEngine({
 *     catalog: [{ id: 'sword', name: 'Sword', price: 100, currency: 'gold' }],
 *     wallet: {
 *       getBalance: async () => player.gold,
 *       deduct:     async n  => { player.gold -= n; },
 *       credit:     async n  => { player.gold += n; },
 *     },
 *     inventory: {
 *       owns: async id => player.items.has(id),
 *       add:  async id => player.items.add(id),
 *     },
 *   });
 *
 *   const result = await engine.purchase('sword');
 *   engine.on('purchase', (item, balance) => hud.update(balance));
 */
export class CommerceEngine extends TypedEventEmitter<CommerceEvents> {
  private readonly cfg: CommerceEngineConfig;

  /** True while a purchase is in flight — prevents concurrent double-spending. */
  private purchasing = false;

  /**
   * Cache of completed successful purchase results, keyed by caller-supplied
   * idempotency key. Entries expire after `idempotencyTtlMs`.
   *
   * Only successful purchases are cached — failed ones (insufficient_funds,
   * adapter_error) can always be retried freely.
   */
  private readonly idempotencyCache = new Map<string, {
    result: PurchaseResult;
    expiresAt: number;
  }>();

  constructor(config: CommerceEngineConfig) {
    super();
    this.cfg = config;
  }

  // ─── Catalog ─────────────────────────────────────────────────────────────

  getCatalog(): readonly CatalogItem[] {
    return this.cfg.catalog;
  }

  getItem(itemId: string): CatalogItem | undefined {
    return this.cfg.catalog.find(i => i.id === itemId);
  }

  // ─── State queries (delegate to adapters) ────────────────────────────────

  async getBalance(): Promise<number> {
    return this.cfg.wallet.getBalance();
  }

  async owns(itemId: string): Promise<boolean> {
    return this.cfg.inventory.owns(itemId);
  }

  // ─── Commerce operations ──────────────────────────────────────────────────

  /**
   * Attempts to purchase an item from the catalog.
   *
   * Guarantees:
   * - No coins are deducted on any failure path.
   * - If `wallet.deduct()` succeeds but `inventory.add()` throws, coins are
   *   refunded via `wallet.credit()` (best-effort rollback).
   * - Only one purchase can be in flight at a time; a second concurrent call
   *   returns `concurrent_request` immediately.
   * - Calls that share an `idempotencyKey` within `idempotencyTtlMs` return
   *   the cached result without re-executing — safe for repeated voice commands.
   *
   * Never throws — always returns a typed PurchaseResult.
   *
   * @param itemId - Catalog item ID to purchase.
   * @param options.idempotencyKey - Stable key for this purchase intent
   *   (e.g. a voice-session command ID). Prevents duplicate transactions when
   *   the same voice command fires more than once.
   */
  async purchase(
    itemId: string,
    options?: { idempotencyKey?: string },
  ): Promise<PurchaseResult> {
    const key = options?.idempotencyKey;

    // 1. Idempotency: return cached result if key already resolved successfully.
    if (key) {
      const cached = this.idempotencyCache.get(key);
      if (cached) {
        if (Date.now() < cached.expiresAt) return cached.result;
        this.idempotencyCache.delete(key); // expired — evict
      }
    }

    // 2. Concurrency guard — single in-flight purchase at a time.
    if (this.purchasing) {
      return { ok: false, reason: "concurrent_request" };
    }
    this.purchasing = true;

    try {
      // 3. Catalog lookup (pure, cannot throw).
      const item = this.getItem(itemId);
      if (!item) return { ok: false, reason: "item_not_found" };

      // 4. Ownership check.
      let alreadyOwned: boolean;
      try {
        alreadyOwned = await this.cfg.inventory.owns(itemId);
      } catch (error) {
        return { ok: false, reason: "adapter_error", error };
      }
      if (alreadyOwned) return { ok: false, reason: "already_owned" };

      // 5. Balance check.
      let balance: number;
      try {
        balance = await this.cfg.wallet.getBalance();
      } catch (error) {
        return { ok: false, reason: "adapter_error", error };
      }
      if (balance < item.price) {
        // Not cached — user may earn more coins and legitimately retry.
        return { ok: false, reason: "insufficient_funds" };
      }

      // 6. Deduct coins.
      try {
        await this.cfg.wallet.deduct(item.price);
      } catch (error) {
        return { ok: false, reason: "adapter_error", error };
      }

      // 7. Add to inventory — with rollback on failure (atomicity guarantee).
      //    Coins must never be lost due to a failed inventory write.
      try {
        await this.cfg.inventory.add(itemId);
      } catch (error) {
        try { await this.cfg.wallet.credit(item.price); } catch { /* rollback best-effort */ }
        return { ok: false, reason: "adapter_error", error };
      }

      // 8. Auto-equip (non-fatal — item is purchased regardless of equip outcome).
      if (this.cfg.autoEquip && this.cfg.equipment) {
        try {
          await this.cfg.equipment.equip(itemId);
          this.emit("equipped", item);
        } catch { /* intentional no-op */ }
      }

      // 9. Emit purchase events.
      const newBalance = await this.cfg.wallet.getBalance().catch(() => balance - item.price);
      this.emit("purchase", item, newBalance);
      this.emit("walletChanged", newBalance);

      const result: PurchaseResult = { ok: true, item };

      // 10. Cache successful result under idempotency key.
      if (key) {
        this.idempotencyCache.set(key, {
          result,
          expiresAt: Date.now() + (this.cfg.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS),
        });
      }

      return result;
    } finally {
      this.purchasing = false;
    }
  }

  /**
   * Equips an already-owned item.
   * Requires an `equipment` adapter in the config.
   * Never throws — always returns a typed EquipResult.
   */
  async equip(itemId: string): Promise<EquipResult> {
    const item = this.getItem(itemId);
    if (!item) return { ok: false, reason: "item_not_found" };

    let owned: boolean;
    try {
      owned = await this.cfg.inventory.owns(itemId);
    } catch (error) {
      return { ok: false, reason: "adapter_error", error };
    }
    if (!owned) return { ok: false, reason: "not_owned" };

    if (this.cfg.equipment) {
      try {
        await this.cfg.equipment.equip(itemId);
      } catch (error) {
        return { ok: false, reason: "adapter_error", error };
      }
    }

    this.emit("equipped", item);
    return { ok: true, item };
  }
}
