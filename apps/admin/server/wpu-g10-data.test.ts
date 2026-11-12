import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-G10: the loaders of /pricing/config and /catalog/limits. A refusal or a failing database is a fixed
// "unavailable", never an empty screen and never the text of an error (R14, R16). Mocked ports.
const world = vi.hoisted(() => ({
  prices: { ok: true, value: { rows: [] as unknown[], invalid: [] as string[] } } as unknown,
  tiers: { ok: true, value: { rows: [] as unknown[] } } as unknown,
  audit: { ok: true, value: { rows: [] as unknown[] } } as unknown,
  readThrows: false,
  previews: [] as unknown[],
  preview: {
    ok: true,
    value: { fxRate: "127", current: null, candidate: {}, deltaMinor: null },
  } as unknown,
}));
vi.mock("./pricing-runtime.ts", () => ({
  readTx: async (fn: (tx: unknown) => unknown) => {
    if (world.readThrows) throw new Error("database down: secret detail");
    return fn({});
  },
}));
vi.mock("@tc/core", async (importActual) => ({
  ...(await importActual<typeof import("@tc/core")>()),
  previewConfigPrice: async (_tx: unknown, input: unknown) => {
    world.previews.push(input);
    return world.preview;
  },
}));
vi.mock("@tc/db", async (importActual) => ({
  ...(await importActual<typeof import("@tc/db")>()),
  adminRepos: () => ({
    configPrices: { read: async () => world.prices },
    tierLimits: { read: async () => world.tiers },
    audit: { search: async () => world.audit },
  }),
  readMarkets: async () => [{ code: "BD" }, { code: "KE" }],
  readFxRateInForce: async () => ({
    id: "f",
    market: "BD",
    rate: "127",
    effectiveFrom: new Date(0),
  }),
}));

const { loadConfigPrices, READ_BY_ORDERS } = await import("./config-price-data.ts");
const { loadTierLimits } = await import("./tier-limits-data.ts");

const ADMIN = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "finance",
  ip: "203.0.113.7",
} as never;
const NOW = new Date("2026-11-12T06:00:00Z");
const clock = { now: () => NOW };
const BY = "0191a000-0000-7000-8000-0000000000ae";
const DNS = "config_price.dns_zone_month";

beforeEach(() => {
  world.readThrows = false;
  world.previews = [];
  world.prices = { ok: true, value: { rows: [], invalid: [] } };
  world.tiers = { ok: true, value: { rows: [] } };
  world.audit = { ok: true, value: { rows: [] } };
  world.preview = {
    ok: true,
    value: { fxRate: "127", current: null, candidate: {}, deltaMinor: null },
  };
});

describe("loadConfigPrices", () => {
  it("lists the four keys, the price in force and the next change; only the hosted zone is read by orders", async () => {
    world.prices = {
      ok: true,
      value: {
        rows: [
          {
            key: DNS,
            unit: "month",
            entries: [
              { from: new Date("2026-11-01T00:00:00Z"), usd: "0.50", by: BY },
              { from: new Date("2026-12-01T00:00:00Z"), usd: "0.60", by: BY },
            ],
          },
        ],
        invalid: ["config_price.snapshot_gb_month"],
      },
    };
    const r = await loadConfigPrices(ADMIN, {}, clock);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.lines.map((l) => l.key)).toEqual([
      "config_price.block_storage_gb_month",
      "config_price.snapshot_gb_month",
      "config_price.load_balancer_month",
      DNS,
    ]);
    const dns = r.value.lines.find((l) => l.key === DNS);
    expect(dns?.inForce?.usd).toBe("0.50");
    expect(dns?.scheduled?.usd).toBe("0.60");
    expect(dns?.readByOrders).toBe(true);
    expect(r.value.lines.filter((l) => l.readByOrders)).toHaveLength(1);
    expect([...READ_BY_ORDERS]).toEqual([DNS]);
    expect(r.value.lines.find((l) => l.key === "config_price.snapshot_gb_month")?.invalid).toBe(
      true,
    );
    expect(r.value.edit).toBeNull();
    // the customer price of the one in force came from the engine, with the price in force
    expect(world.previews).toContainEqual({ market: "BD", key: DNS, usd: "0.50" });
  });

  it("opens the editor on the price in force and previews only on go=preview, with the current price for the change", async () => {
    world.prices = {
      ok: true,
      value: {
        rows: [
          { key: DNS, unit: "month", entries: [{ from: new Date(0), usd: "0.50", by: null }] },
        ],
        invalid: [],
      },
    };
    const open = await loadConfigPrices(ADMIN, { key: DNS }, clock);
    if (open.kind !== "ok") throw new Error("unavailable");
    expect(open.value.edit).toMatchObject({
      key: DNS,
      usd: "0.50",
      go: false,
      preview: { kind: "none" },
    });
    world.previews = [];
    const shown = await loadConfigPrices(
      ADMIN,
      { key: DNS, go: "preview", usd: "0.75", from: "2026-12-01T09:00" },
      clock,
    );
    if (shown.kind !== "ok") throw new Error("unavailable");
    expect(shown.value.edit).toMatchObject({
      usd: "0.75",
      from: "2026-12-01T09:00",
      go: true,
      preview: { kind: "ok" },
    });
    expect(world.previews).toContainEqual({ market: "BD", key: DNS, usd: "0.75", current: "0.50" });
  });

  it("a draft that is not a price or a start gets the names of the fields and no engine call", async () => {
    const r = await loadConfigPrices(
      ADMIN,
      { key: DNS, go: "preview", usd: "1e3", from: "soon" },
      clock,
    );
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.edit?.preview).toEqual({ kind: "invalid", fields: ["usd", "from"] });
    expect(world.previews.filter((p) => (p as { usd: string }).usd === "1e3")).toEqual([]);
  });

  it("an engine that refuses is an unavailable preview, a validation refusal names its fields", async () => {
    world.preview = { ok: false, error: "not_found", fields: { fxRate: "not_in_force" } };
    let r = await loadConfigPrices(ADMIN, { key: DNS, go: "preview", usd: "1" }, clock);
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.edit?.preview).toEqual({ kind: "unavailable" });
    world.preview = { ok: false, error: "validation", fields: { usd: "invalid" } };
    r = await loadConfigPrices(ADMIN, { key: DNS, go: "preview", usd: "1" }, clock);
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.edit?.preview).toEqual({ kind: "invalid", fields: ["usd"] });
  });

  it("keeps only the audit rows of this market and this price", async () => {
    world.audit = {
      ok: true,
      value: {
        rows: [
          { id: "a", targetId: `BD/${DNS}@x`, reason: "mine" },
          { id: "b", targetId: `KE/${DNS}@x`, reason: "other market" },
          { id: "c", targetId: "BD/config_price.snapshot_gb_month@x", reason: "other price" },
        ],
      },
    };
    const r = await loadConfigPrices(ADMIN, { key: DNS }, clock);
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.edit?.history.map((h) => h.id)).toEqual(["a"]);
  });

  it("a refused repository read, or a failing database, is unavailable without the text of the error", async () => {
    world.prices = { ok: false, error: "forbidden" };
    expect(await loadConfigPrices(ADMIN, {}, clock)).toEqual({ kind: "unavailable" });
    world.readThrows = true;
    const r = await loadConfigPrices(ADMIN, {}, clock);
    expect(r).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("a market the store does not have falls back to the first market it has", async () => {
    const r = await loadConfigPrices(ADMIN, { market: "ZZ" }, clock);
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.market).toBe("BD");
  });
});

describe("loadTierLimits", () => {
  it("a tier with no row shows the defaults of the core as the default source", async () => {
    const r = await loadTierLimits(ADMIN, {});
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.lines.map((l) => [l.tier, l.source])).toEqual([
      ["new", "default"],
      ["trusted", "default"],
    ]);
    expect(r.value.lines[0]?.limits).toEqual(r.value.lines[0]?.defaults);
    expect(r.value.lines[0]?.limits?.maxInstances).toBe(50);
  });

  it("a stored row shows its limits, an unreadable one shows no limits (the order path refuses)", async () => {
    const stored = {
      maxInstances: 7,
      maxBundleUsd: "40",
      windows: true,
      containers: false,
      maxStaticIps: 2,
    };
    world.tiers = {
      ok: true,
      value: {
        rows: [
          { tier: "new", state: "ok", limits: stored },
          { tier: "trusted", state: "invalid" },
        ],
      },
    };
    const r = await loadTierLimits(ADMIN, { tier: "new" });
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.lines[0]).toMatchObject({ source: "stored", limits: stored });
    expect(r.value.lines[1]).toMatchObject({ source: "invalid", limits: null });
    expect(r.value.open).toBe("new");
    expect(
      await loadTierLimits(ADMIN, { tier: "vip" }).then((x) =>
        x.kind === "ok" ? x.value.open : "?",
      ),
    ).toBeNull();
  });

  it("keeps only the audit rows of this market and tier", async () => {
    world.audit = {
      ok: true,
      value: {
        rows: [
          { id: "a", targetId: "BD/new" },
          { id: "b", targetId: "KE/new" },
          { id: "c", targetId: "BD/trusted" },
        ],
      },
    };
    const r = await loadTierLimits(ADMIN, {});
    if (r.kind !== "ok") throw new Error("unavailable");
    expect(r.value.lines[0]?.history.map((h) => h.id)).toEqual(["a"]);
    expect(r.value.lines[1]?.history.map((h) => h.id)).toEqual(["c"]);
  });

  it("a refused repository read, or a failing database, is unavailable without the text of the error", async () => {
    world.tiers = { ok: false, error: "forbidden" };
    expect(await loadTierLimits(ADMIN, {})).toEqual({ kind: "unavailable" });
    world.readThrows = true;
    const r = await loadTierLimits(ADMIN, {});
    expect(r).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
