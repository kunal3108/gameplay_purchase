// Pure, Phaser-free helpers used by server tests and mirrored in ShopHUDScene.

export interface WeaponEntry {
  id: string;
  name: string;
  price: number;
}

export interface OwnedEntry extends WeaponEntry {
  equipped: boolean;
}

export interface PurchasableEntry extends WeaponEntry {
  canAfford: boolean;
}

export interface CategoryResult {
  arsenal: OwnedEntry[];
  armory: PurchasableEntry[];
}

/**
 * Split a weapon catalogue into owned (arsenal) and purchasable (armory) based on
 * the player's current state. Pure function — no side effects.
 */
export function categorizeWeapons(
  catalogue: WeaponEntry[],
  ownedIds: string[],
  equippedId: string,
  balance: number,
): CategoryResult {
  return {
    arsenal: catalogue
      .filter(w => ownedIds.includes(w.id))
      .map(w => ({ ...w, equipped: w.id === equippedId })),
    armory: catalogue
      .filter(w => !ownedIds.includes(w.id))
      .map(w => ({ ...w, canAfford: balance >= w.price })),
  };
}

/**
 * Tracks which weapon IDs are currently highlighted and auto-clears after timeoutMs.
 * Repeated highlight() calls reset the timer (refresh semantics).
 */
export class HighlightTimer {
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private activeIds: string[] = [];
  private activeArea: 'arsenal' | 'armory' | null = null;

  constructor(private readonly timeoutMs: number = 5_000) {}

  highlight(weaponIds: string[], area: 'arsenal' | 'armory'): void {
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.activeIds = [...weaponIds];
    this.activeArea = area;
    this.timerId = setTimeout(() => {
      this.activeIds = [];
      this.activeArea = null;
      this.timerId = null;
    }, this.timeoutMs);
  }

  getActiveIds(): string[] { return this.activeIds; }
  getActiveArea(): 'arsenal' | 'armory' | null { return this.activeArea; }
  isActive(weaponId: string): boolean { return this.activeIds.includes(weaponId); }

  clear(): void {
    if (this.timerId !== null) { clearTimeout(this.timerId); this.timerId = null; }
    this.activeIds = [];
    this.activeArea = null;
  }
}
