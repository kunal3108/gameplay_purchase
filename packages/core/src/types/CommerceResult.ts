import type { CatalogItem } from "./CatalogItem.js";

export type PurchaseResult =
  | { ok: true; item: CatalogItem }
  | {
      ok: false;
      reason:
        | "already_owned"       // player already owns this item
        | "insufficient_funds"  // balance too low
        | "item_not_found"      // id not in catalog
        | "concurrent_request"  // another purchase is already in flight
        | "adapter_error";      // a wallet/inventory adapter threw unexpectedly
      /** Original thrown value — only populated for adapter_error. */
      error?: unknown;
    };

export type EquipResult =
  | { ok: true; item: CatalogItem }
  | {
      ok: false;
      reason:
        | "not_owned"      // player does not own this item
        | "item_not_found" // id not in catalog
        | "adapter_error"; // an inventory/equipment adapter threw unexpectedly
      /** Original thrown value — only populated for adapter_error. */
      error?: unknown;
    };
