import type { WeaponId } from '../types/game';

export type PurchaseResult =
  | { ok: true }
  | { ok: false; reason: 'already_owned' | 'insufficient_funds' };

export class WalletStore {
  private _balance: number;
  private readonly _inventory: Set<WeaponId>;

  constructor(startingBalance = 1000) {
    this._balance = startingBalance;
    this._inventory = new Set<WeaponId>();
    this._inventory.add('pistol'); // owned by default
  }

  get balance(): number {
    return this._balance;
  }

  get inventory(): ReadonlySet<WeaponId> {
    return this._inventory;
  }

  owns(id: WeaponId): boolean {
    return this._inventory.has(id);
  }

  /** Add coins (e.g. enemy kill reward). Used by CommerceEngine's credit adapter. */
  addCoins(amount: number): void {
    this._balance += amount;
  }

  /** Deduct coins. Used by CommerceEngine's deduct adapter. */
  deductCoins(amount: number): void {
    this._balance -= amount;
  }

  /** Add an item directly to inventory. Used by CommerceEngine's inventory.add adapter. */
  addToInventory(id: WeaponId): void {
    this._inventory.add(id);
  }

  /** Deducts coins and adds weapon to inventory. Returns result without throwing. */
  purchase(id: WeaponId, price: number): PurchaseResult {
    if (this._inventory.has(id)) {
      return { ok: false, reason: 'already_owned' };
    }
    if (this._balance < price) {
      return { ok: false, reason: 'insufficient_funds' };
    }
    this._balance -= price;
    this._inventory.add(id);
    return { ok: true };
  }
}
