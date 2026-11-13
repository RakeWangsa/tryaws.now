import type { AuditRow } from "@tc/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-Z4: the loader of /operations/unpaid-rule. For each market the switch as the job reads it and the last
// change from the audit log (a replay is skipped). A refusal of the repository is `denied` (the neutral page),
// a failing database is a fixed `unavailable`, never the text of an error (R14, R16). Mocked ports.
const world = vi.hoisted(() => ({
  markets: ["BD"] as string[],
  reads: {} as Record<string, unknown>,
  audits: {} as Record<string, unknown>,
  readCalls: [] as unknown[],
  searches: [] as unknown[],
  readThrows: false,
}));
vi.mock("./pricing-runtime.ts", () => ({
  readTx: async (fn: (tx: unknown) => unknown) => {
    if (world.readThrows) throw new Error("database down: secret detail");
    return fn({});
  },
}));
vi.mock("@tc/db", async (importActual) => ({
  ...(await importActual<typeof import("@tc/db")>()),
  adminRepos: () => ({
    settings: {
      read: async (key: string, market: string) => {
        world.readCalls.push([key, market]);
        return (
          world.reads[market] ?? {
            ok: true,
            replayed: false,
            value: { key, market, enabled: false, source: "none" },
          }
        );
      },
    },
    audit: {
      search: async (input: { targetId: string }) => {
        world.searches.push(input);
        return world.audits[input.targetId] ?? { ok: true, value: { rows: [], nextAfter: null } };
      },
    },
  }),
  readMarketCodes: async () => world.markets,
}));

const { lastChangeOf, loadUnpaidRule } = await import("./unpaid-rule-data.ts");

const ADMIN = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "support",
  ip: "203.0.113.7",
} as const;
const BY = "0191a000-0000-7000-8000-0000000000ae";
const KEY = "lifecycle_unpaid_enabled";
const T1 = new Date("2026-11-12T06:00:00Z");
const T2 = new Date("2026-11-13T06:00:00Z");

const row = (over: Partial<AuditRow>): AuditRow => ({
  id: "0191a000-0000-7000-8000-0000000000f1",
  createdAt: T1,
  actorType: "admin",
  actorId: BY,
  action: "setting.set",
  targetType: "setting",
  targetId: `BD:${KEY}`,
  ip: "203.0.113.9",
  userAgent: null,
  reason: "pilot customers",
  before: null,
  after: { value: true },
  extra: {},
  ...over,
});

beforeEach(() => {
  world.markets = ["BD"];
  world.reads = {};
  world.audits = {};
  world.readCalls = [];
  world.searches = [];
  world.readThrows = false;
});

describe("lastChangeOf", () => {
  it("takes the newest row that changed the value; a replay (before = after) is skipped", () => {
    const rows = [
      row({ createdAt: T2, reason: "again", before: { value: true }, after: { value: true } }),
      row({ createdAt: T1, reason: "pilot customers", before: null, after: { value: true } }),
    ];
    expect(lastChangeOf(rows)).toEqual({
      by: BY,
      at: T1,
      reason: "pilot customers",
      enabled: true,
    });
  });

  it("a change to off, and a stored value that was not a boolean, are changes too", () => {
    expect(lastChangeOf([row({ before: { value: true }, after: { value: false } })])).toMatchObject(
      { enabled: false },
    );
    expect(
      lastChangeOf([row({ before: { value: "true" }, after: { value: false } })]),
    ).toMatchObject({ enabled: false });
  });

  it("no row, or only replays, is no change", () => {
    expect(lastChangeOf([])).toBeNull();
    expect(lastChangeOf([row({ before: { value: false }, after: { value: false } })])).toBeNull();
  });
});

describe("loadUnpaidRule", () => {
  it("reads the switch of every market and searches the audit log for its own target", async () => {
    world.markets = ["BD", "KE"];
    world.reads["BD"] = {
      ok: true,
      replayed: false,
      value: { key: KEY, market: "BD", enabled: true, source: "stored" },
    };
    world.audits[`BD:${KEY}`] = { ok: true, value: { rows: [row({})], nextAfter: null } };
    const out = await loadUnpaidRule(ADMIN);
    expect(out).toEqual({
      kind: "ok",
      value: {
        lines: [
          {
            market: "BD",
            enabled: true,
            source: "stored",
            lastChange: { by: BY, at: T1, reason: "pilot customers", enabled: true },
          },
          { market: "KE", enabled: false, source: "none", lastChange: null },
        ],
      },
    });
    expect(world.readCalls).toEqual([
      [KEY, "BD"],
      [KEY, "KE"],
    ]);
    expect(world.searches).toEqual([
      { action: "setting.set", targetType: "setting", targetId: `BD:${KEY}`, limit: 100 },
      { action: "setting.set", targetType: "setting", targetId: `KE:${KEY}`, limit: 100 },
    ]);
  });

  it("no market is an empty screen, not an error", async () => {
    world.markets = [];
    expect(await loadUnpaidRule(ADMIN)).toEqual({ kind: "ok", value: { lines: [] } });
  });

  it("a refusal of the repository is the neutral page; another refusal is unavailable", async () => {
    world.reads["BD"] = { ok: false, error: "forbidden" };
    expect(await loadUnpaidRule(ADMIN)).toEqual({ kind: "denied" });
    world.reads["BD"] = { ok: false, error: "validation" };
    expect(await loadUnpaidRule(ADMIN)).toEqual({ kind: "unavailable" });
    world.reads = {};
    world.audits[`BD:${KEY}`] = { ok: false, error: "forbidden" };
    expect(await loadUnpaidRule(ADMIN)).toEqual({ kind: "denied" });
  });

  it("a failing database is unavailable and tells nothing", async () => {
    world.readThrows = true;
    const out = await loadUnpaidRule(ADMIN);
    expect(out).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});
