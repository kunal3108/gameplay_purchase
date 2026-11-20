import type { CatalogItem } from "../types/CatalogItem.js";
import type { WalletStateAdapter } from "./WalletStateAdapter.js";
import type { InventoryAdapter } from "./InventoryAdapter.js";
import type { EquipmentAdapter } from "./EquipmentAdapter.js";

export interface CommerceEngineConfig {
  /** All purchasable items. The engine treats this as immutable. */
  catalog: readonly CatalogItem[];

  wallet: WalletStateAdapter;
  inventory: InventoryAdapter;

  /** Required if `engine.equip()` will be called or `autoEquip` is enabled. */
  equipment?: EquipmentAdapter;

  /**
   * Automatically equip an item immediately after a successful purchase.
   * Requires an `equipment` adapter. Auto-equip failure is non-fatal —
   * the item remains in inventory even if equipping throws.
   * Default: false.
   */
  autoEquip?: boolean;

  /**
   * How long (ms) a successful purchase result is kept in the idempotency
   * cache when a caller supplies an `idempotencyKey`. A second call with the
   * same key within this window returns the cached result without re-executing
   * the purchase — preventing duplicate transactions from repeated voice commands.
   * Default: 30 000 (30 seconds).
   */
  idempotencyTtlMs?: number;
}
