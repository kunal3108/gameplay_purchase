/**
 * Adapter that gives the CommerceEngine read/write access to the
 * game's authoritative item inventory.
 */
export interface InventoryAdapter {
  /** Returns true if the player already owns this item id. */
  owns(itemId: string): Promise<boolean>;
  /** Adds an item after a successful purchase. */
  add(itemId: string): Promise<void>;
}
