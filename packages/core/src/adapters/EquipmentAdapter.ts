/**
 * Optional adapter for game-side equipment state.
 * Provide this when the CommerceEngine should orchestrate equip() calls.
 * All game-engine-specific logic (e.g. switching Phaser sprites) lives here.
 */
export interface EquipmentAdapter {
  /** Equips the item. Called only after ownership is confirmed. */
  equip(itemId: string): Promise<void>;
  /** Returns the currently equipped item id, or null. */
  getEquipped(): string | null;
}
