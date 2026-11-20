import type { GameItem } from "./GameItem.js";

export interface PurchaseAdapter {
  purchase(item: GameItem): Promise<{ txId: string }>;
}
