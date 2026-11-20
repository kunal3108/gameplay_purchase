export interface WalletAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getBalance(currency: string): Promise<number>;
}
