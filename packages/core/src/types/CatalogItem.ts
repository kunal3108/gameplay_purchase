import type { GameItem } from "./GameItem.js";

/**
 * A purchasable item in the game's item catalog.
 * Extends the base GameItem with optional freeform metadata.
 */
export interface CatalogItem extends GameItem {
  metadata?: Record<string, unknown>;
}
