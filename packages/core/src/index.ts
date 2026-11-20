// ─── Original interfaces (preserved) ───────────────────────
export type { GameItem } from "./types/GameItem.js";
export type { WalletAdapter } from "./types/WalletAdapter.js";
export type { PurchaseAdapter } from "./types/PurchaseAdapter.js";
export type { VoiceProviderAdapter } from "./types/VoiceProviderAdapter.js";

// ─── Commerce SDK ───────────────────────────────────────────
export type { CatalogItem } from "./types/CatalogItem.js";
export type { PurchaseResult, EquipResult } from "./types/CommerceResult.js";

export type { WalletStateAdapter } from "./adapters/WalletStateAdapter.js";
export type { InventoryAdapter } from "./adapters/InventoryAdapter.js";
export type { EquipmentAdapter } from "./adapters/EquipmentAdapter.js";
export type { CommerceEngineConfig } from "./adapters/CommerceEngineConfig.js";

export { CommerceEngine } from "./CommerceEngine.js";
export { TypedEventEmitter } from "./TypedEventEmitter.js";
