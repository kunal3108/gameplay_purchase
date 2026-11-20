/**
 * Adapter that gives the CommerceEngine read/write access to the
 * game's authoritative wallet balance.
 *
 * The game owns the actual balance — the SDK never stores it internally.
 * Async signatures future-proof against blockchain or server-side wallets.
 */
export interface WalletStateAdapter {
  /** Returns the current spendable balance. */
  getBalance(): Promise<number>;
  /** Deducts `amount`. Called only after a successful balance check. */
  deduct(amount: number): Promise<void>;
  /** Credits `amount` (e.g. for kill rewards or refunds). */
  credit(amount: number): Promise<void>;
}
