import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommerceEngine } from "../CommerceEngine";
import type { CommerceEngineConfig } from "../adapters/CommerceEngineConfig";

// ─── Test fixture ─────────────────────────────────────────────────────────────

function makeConfig(
  startingBalance = 1000,
  ownedIds: string[] = ["pistol"],
): {
  config: CommerceEngineConfig;
  getCoins: () => number;
  getInventory: () => Set<string>;
} {
  let coins = startingBalance;
  const inventory = new Set<string>(ownedIds);

  const config: CommerceEngineConfig = {
    catalog: [
      { id: "pistol",  name: "Pistol",    price: 0,   currency: "coins" },
      { id: "shotgun", name: "Shotgun",   price: 300, currency: "coins" },
      { id: "laser",   name: "Laser Gun", price: 500, currency: "coins" },
    ],
    wallet: {
      getBalance: async () => coins,
      deduct:     async (n) => { coins -= n; },
      credit:     async (n) => { coins += n; },
    },
    inventory: {
      owns: async (id) => inventory.has(id),
      add:  async (id) => { inventory.add(id); },
    },
  };

  return { config, getCoins: () => coins, getInventory: () => inventory };
}

// ─── Purchase ─────────────────────────────────────────────────────────────────

describe("CommerceEngine – purchase", () => {
  it("succeeds, deducts balance and returns the item", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.id).toBe("shotgun");
    expect(getCoins()).toBe(700); // 1000 - 300
  });

  it("allows free items (price 0) without touching balance", async () => {
    const { config, getCoins } = makeConfig(0, []); // zero coins, nothing owned
    const engine = new CommerceEngine(config);

    const result = await engine.purchase("pistol");

    expect(result.ok).toBe(true);
    expect(getCoins()).toBe(0); // unchanged
  });

  it("returns already_owned without deducting balance", async () => {
    const { config, getCoins } = makeConfig(1000, ["pistol", "shotgun"]);
    const engine = new CommerceEngine(config);

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already_owned");
    expect(getCoins()).toBe(1000); // unchanged
  });

  it("returns insufficient_funds without deducting balance", async () => {
    const { config, getCoins } = makeConfig(100); // only 100 coins
    const engine = new CommerceEngine(config);

    const result = await engine.purchase("laser"); // costs 500

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_funds");
    expect(getCoins()).toBe(100); // unchanged
  });

  it("returns item_not_found for unknown item ids", async () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);

    const result = await engine.purchase("nonexistent-item");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("item_not_found");
  });

  it("prevents concurrent double-spending via the purchasing flag", async () => {
    // Starting two purchases in the same synchronous tick means only the first
    // can run past the 'this.purchasing = true' guard before the second starts.
    // The first yields at 'await inventory.owns()'; the second sees the flag and
    // immediately returns concurrent_request.
    const { config } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    const p1 = engine.purchase("shotgun"); // sets purchasing=true, then yields
    const p2 = engine.purchase("laser");   // sees purchasing=true → concurrent_request

    const [r1, r2] = await Promise.all([p1, p2]);

    const successes = [r1, r2].filter(r => r.ok);
    expect(successes).toHaveLength(1);

    const failed = r1.ok ? r2 : r1;
    expect(!failed.ok && failed.reason).toBe("concurrent_request");
  });

  it("allows a second purchase after the first completes", async () => {
    const { config } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    await engine.purchase("shotgun"); // 1000 - 300 = 700
    const result = await engine.purchase("laser"); // 700 - 500 = 200

    expect(result.ok).toBe(true);
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe("CommerceEngine – events", () => {
  it("emits purchase and walletChanged events on success", async () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);
    const purchased: string[] = [];
    const balances: number[] = [];

    engine.on("purchase",      (item)    => purchased.push(item.id));
    engine.on("walletChanged", (balance) => balances.push(balance));

    await engine.purchase("shotgun");

    expect(purchased).toEqual(["shotgun"]);
    expect(balances).toEqual([700]); // 1000 - 300
  });

  it("does not emit events on a failed purchase", async () => {
    const { config } = makeConfig(50); // not enough for anything
    const engine = new CommerceEngine(config);
    const events: string[] = [];

    engine.on("purchase",      () => events.push("purchase"));
    engine.on("walletChanged", () => events.push("walletChanged"));

    await engine.purchase("shotgun");

    expect(events).toHaveLength(0);
  });

  it("removes a listener with off()", async () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);
    const calls: number[] = [];
    const listener = (b: number) => calls.push(b);

    engine.on("walletChanged", listener);
    await engine.purchase("shotgun"); // fires once
    engine.off("walletChanged", listener);
    await engine.purchase("laser");   // should NOT fire

    expect(calls).toHaveLength(1);
  });
});

// ─── Equip ────────────────────────────────────────────────────────────────────

describe("CommerceEngine – equip", () => {
  it("equips an owned item and emits equipped event", async () => {
    let equipped = "";
    const { config } = makeConfig(1000, ["pistol", "shotgun"]);
    const engine = new CommerceEngine({
      ...config,
      equipment: {
        equip:       async (id) => { equipped = id; },
        getEquipped: ()         => equipped || null,
      },
    });
    const events: string[] = [];
    engine.on("equipped", (item) => events.push(item.id));

    const result = await engine.equip("shotgun");

    expect(result.ok).toBe(true);
    expect(equipped).toBe("shotgun");
    expect(events).toEqual(["shotgun"]);
  });

  it("returns not_owned when equipping an unowned item", async () => {
    const { config } = makeConfig(1000, ["pistol"]);
    const engine = new CommerceEngine(config);

    const result = await engine.equip("laser");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_owned");
  });

  it("returns item_not_found for unknown item ids", async () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);

    const result = await engine.equip("unknown-item");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("item_not_found");
  });
});

// ─── State queries ────────────────────────────────────────────────────────────

describe("CommerceEngine – state queries", () => {
  it("getBalance() delegates to the wallet adapter", async () => {
    const { config } = makeConfig(750);
    const engine = new CommerceEngine(config);
    expect(await engine.getBalance()).toBe(750);
  });

  it("owns() delegates to the inventory adapter", async () => {
    const { config } = makeConfig(1000, ["pistol", "shotgun"]);
    const engine = new CommerceEngine(config);
    expect(await engine.owns("pistol")).toBe(true);
    expect(await engine.owns("laser")).toBe(false);
  });

  it("getCatalog() returns all items", () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);
    expect(engine.getCatalog()).toHaveLength(3);
  });

  it("getItem() returns undefined for unknown ids", () => {
    const { config } = makeConfig();
    const engine = new CommerceEngine(config);
    expect(engine.getItem("unknown")).toBeUndefined();
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("CommerceEngine – idempotency keys", () => {
  it("returns cached result for same key — no second deduction", async () => {
    const { config, getCoins, getInventory } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    const r1 = await engine.purchase("shotgun", { idempotencyKey: "cmd-001" });
    expect(r1.ok).toBe(true);
    expect(getCoins()).toBe(700);

    // Second call with same key: should return cached result, not re-execute
    const r2 = await engine.purchase("shotgun", { idempotencyKey: "cmd-001" });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.item.id).toBe("shotgun");
    expect(getCoins()).toBe(700); // unchanged — no second deduction
    expect(getInventory().has("shotgun")).toBe(true);
  });

  it("without an idempotency key the second call returns already_owned", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    await engine.purchase("shotgun"); // no key
    const r2 = await engine.purchase("shotgun"); // no key — inventory check fires

    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("already_owned");
    expect(getCoins()).toBe(700); // only one deduction total
  });

  it("different keys execute independently", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    await engine.purchase("shotgun", { idempotencyKey: "cmd-001" }); // 700 coins
    const r2 = await engine.purchase("laser", { idempotencyKey: "cmd-002" }); // 200 coins

    expect(r2.ok).toBe(true);
    expect(getCoins()).toBe(200);
  });

  it("expired key allows the purchase to re-execute", async () => {
    let coins = 1000;
    const inventory = new Set<string>(["pistol"]);

    const engine = new CommerceEngine({
      catalog: [
        { id: "pistol",  name: "Pistol",    price: 0,   currency: "coins" },
        { id: "shotgun", name: "Shotgun",   price: 300, currency: "coins" },
        { id: "laser",   name: "Laser Gun", price: 500, currency: "coins" },
      ],
      wallet: {
        getBalance: async () => coins,
        deduct:     async (n) => { coins -= n; },
        credit:     async (n) => { coins += n; },
      },
      inventory: {
        owns: async (id) => inventory.has(id),
        add:  async (id) => { inventory.add(id); },
      },
      idempotencyTtlMs: 50, // very short TTL for testing
    });

    await engine.purchase("shotgun", { idempotencyKey: "cmd-x" });
    expect(coins).toBe(700);

    // Simulate a fresh session: roll back state so the item is purchasable again
    inventory.delete("shotgun");
    coins = 1000;

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 100));

    // Key is expired — purchase should execute fresh, not return stale cache
    const result = await engine.purchase("shotgun", { idempotencyKey: "cmd-x" });
    expect(result.ok).toBe(true);
    expect(coins).toBe(700); // fresh deduction
  });
});

// ─── Atomicity / partial-failure protection ───────────────────────────────────

describe("CommerceEngine – atomicity", () => {
  it("refunds coins when inventory.add() throws after wallet.deduct()", async () => {
    // This is the critical partial-failure scenario: coins leave the wallet but
    // inventory is never updated. Without rollback the player loses their coins.
    let coins = 1000;

    const engine = new CommerceEngine({
      catalog: [{ id: "shotgun", name: "Shotgun", price: 300, currency: "coins" }],
      wallet: {
        getBalance: async () => coins,
        deduct:     async (n) => { coins -= n; },
        credit:     async (n) => { coins += n; },
      },
      inventory: {
        owns: async () => false,
        add:  async () => { throw new Error("DB write failed"); },
      },
    });

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("adapter_error");
    expect(coins).toBe(1000); // refunded — net change is zero
  });

  it("does not deduct coins when wallet.deduct() itself throws", async () => {
    let coins = 1000;
    const inventory = new Set<string>();

    const engine = new CommerceEngine({
      catalog: [{ id: "shotgun", name: "Shotgun", price: 300, currency: "coins" }],
      wallet: {
        getBalance: async () => coins,
        deduct:     async () => { throw new Error("Payment gateway timeout"); },
        credit:     async (n) => { coins += n; },
      },
      inventory: {
        owns: async (id) => inventory.has(id),
        add:  async (id) => { inventory.add(id); },
      },
    });

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("adapter_error");
    expect(coins).toBe(1000);         // unchanged
    expect(inventory.has("shotgun")).toBe(false); // inventory untouched
  });

  it("fails cleanly when inventory.owns() throws during purchase", async () => {
    let coins = 1000;

    const engine = new CommerceEngine({
      catalog: [{ id: "shotgun", name: "Shotgun", price: 300, currency: "coins" }],
      wallet: {
        getBalance: async () => coins,
        deduct:     async (n) => { coins -= n; },
        credit:     async (n) => { coins += n; },
      },
      inventory: {
        owns: async () => { throw new Error("Inventory service unavailable"); },
        add:  async () => { /* unused */ },
      },
    });

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("adapter_error");
    expect(coins).toBe(1000); // wallet never touched
  });

  it("fails cleanly when wallet.getBalance() throws", async () => {
    let coins = 1000;
    const inventory = new Set<string>();

    const engine = new CommerceEngine({
      catalog: [{ id: "shotgun", name: "Shotgun", price: 300, currency: "coins" }],
      wallet: {
        getBalance: async () => { throw new Error("Wallet service unavailable"); },
        deduct:     async (n) => { coins -= n; },
        credit:     async (n) => { coins += n; },
      },
      inventory: {
        owns: async () => false,
        add:  async (id) => { inventory.add(id); },
      },
    });

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("adapter_error");
    expect(coins).toBe(1000);
    expect(inventory.has("shotgun")).toBe(false);
  });

  it("three simultaneous purchases — exactly one succeeds", async () => {
    const { config } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    // Fire three in the same tick: first sets purchasing=true,
    // second and third see the flag and get concurrent_request
    const [r1, r2, r3] = await Promise.all([
      engine.purchase("shotgun"),
      engine.purchase("laser"),
      engine.purchase("shotgun"),
    ]);

    const successes = [r1, r2, r3].filter(r => r.ok);
    expect(successes).toHaveLength(1);

    const failures = [r1, r2, r3].filter(r => !r.ok);
    expect(failures.every(r => !r.ok && r.reason === "concurrent_request")).toBe(true);
  });
});

// ─── Auto-equip ───────────────────────────────────────────────────────────────

describe("CommerceEngine – autoEquip", () => {
  it("automatically equips the item and emits equipped after purchase", async () => {
    let equipped = "";
    const { config } = makeConfig(1000);
    const engine = new CommerceEngine({
      ...config,
      autoEquip: true,
      equipment: {
        equip:       async (id) => { equipped = id; },
        getEquipped: ()         => equipped || null,
      },
    });

    const equipEvents: string[] = [];
    engine.on("equipped", (item) => equipEvents.push(item.id));

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(true);
    expect(equipped).toBe("shotgun");
    expect(equipEvents).toEqual(["shotgun"]);
  });

  it("purchase succeeds when autoEquip:true but no equipment adapter provided", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine({
      ...config,
      autoEquip: true,
      // no equipment adapter — should not throw
    });

    const result = await engine.purchase("shotgun");

    expect(result.ok).toBe(true);
    expect(getCoins()).toBe(700);
  });

  it("purchase succeeds even when auto-equip adapter throws (non-fatal)", async () => {
    const { config, getCoins, getInventory } = makeConfig(1000);
    const engine = new CommerceEngine({
      ...config,
      autoEquip: true,
      equipment: {
        equip:       async () => { throw new Error("equip adapter down"); },
        getEquipped: ()         => null,
      },
    });

    const result = await engine.purchase("shotgun");

    // Purchase must succeed despite equip failure
    expect(result.ok).toBe(true);
    expect(getCoins()).toBe(700);
    expect(getInventory().has("shotgun")).toBe(true);
  });
});

// ─── Adapter errors in equip ──────────────────────────────────────────────────

describe("CommerceEngine – equip adapter errors", () => {
  it("returns adapter_error when equipment.equip() throws", async () => {
    const { config } = makeConfig(1000, ["pistol", "shotgun"]);
    const engine = new CommerceEngine({
      ...config,
      equipment: {
        equip:       async () => { throw new Error("equip service down"); },
        getEquipped: ()         => null,
      },
    });

    const result = await engine.equip("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("adapter_error");
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns adapter_error when inventory.owns() throws during equip", async () => {
    const engine = new CommerceEngine({
      catalog: [{ id: "shotgun", name: "Shotgun", price: 300, currency: "coins" }],
      wallet: {
        getBalance: async () => 1000,
        deduct:     async () => { /* unused */ },
        credit:     async () => { /* unused */ },
      },
      inventory: {
        owns: async () => { throw new Error("Inventory service unavailable"); },
        add:  async () => { /* unused */ },
      },
    });

    const result = await engine.equip("shotgun");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("adapter_error");
  });

  it("does not emit equipped event when adapter throws", async () => {
    const { config } = makeConfig(1000, ["pistol", "shotgun"]);
    const engine = new CommerceEngine({
      ...config,
      equipment: {
        equip:       async () => { throw new Error("equip failed"); },
        getEquipped: ()         => null,
      },
    });
    const events: string[] = [];
    engine.on("equipped", (item) => events.push(item.id));

    await engine.equip("shotgun");

    expect(events).toHaveLength(0);
  });
});

// ─── Wallet and inventory consistency ────────────────────────────────────────

describe("CommerceEngine – wallet and inventory consistency", () => {
  it("final balance equals starting balance minus item price", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    await engine.purchase("shotgun"); // -300
    await engine.purchase("laser");   // -500

    expect(getCoins()).toBe(200); // 1000 - 300 - 500
  });

  it("inventory grows by exactly one item per successful purchase", async () => {
    const { config, getInventory } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    const before = getInventory().size; // pistol
    await engine.purchase("shotgun");
    await engine.purchase("laser");

    expect(getInventory().size).toBe(before + 2);
    expect(getInventory().has("shotgun")).toBe(true);
    expect(getInventory().has("laser")).toBe(true);
  });

  it("failed purchases leave balance and inventory unchanged", async () => {
    const { config, getCoins, getInventory } = makeConfig(100); // only 100 coins

    const engine = new CommerceEngine(config);
    const before = getInventory().size;

    await engine.purchase("shotgun"); // insufficient_funds (300)
    await engine.purchase("laser");   // insufficient_funds (500)

    expect(getCoins()).toBe(100);
    expect(getInventory().size).toBe(before);
  });

  it("getBalance() and getCoins() agree after purchases", async () => {
    const { config, getCoins } = makeConfig(1000);
    const engine = new CommerceEngine(config);

    await engine.purchase("shotgun");

    expect(await engine.getBalance()).toBe(700);
    expect(getCoins()).toBe(700);
  });
});
