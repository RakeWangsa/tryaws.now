import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-G4: /dns and /dns/[id]. Cross-tenant (R8), the flag (R12), the stale list (R16) and what never
// leaves the loaders (U6, R11).

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ZONE = "0190aaaa-0000-7000-8000-0000000000d1";

interface Row {
  id: string;
  owner: string;
  family: string;
  state: string;
  config: unknown;
}
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  ops: [] as { kind: string; state: string; createdAt: Date }[],
  flag: true as boolean | undefined,
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readFeatureFlag: async () => state.flag,
  customerRepos: (_tx: unknown, customerId: string) => ({
    profile: { get: async () => ({ market: "BD" }) },
    resources: {
      list: async () =>
        state.rows
          .filter((r) => r.owner === customerId)
          .map((r) => ({
            ...r,
            productId: null,
            region: null,
            parentResourceId: null,
            createdAt: new Date(),
            deletedAt: null,
          })),
      get: async (id: string) => {
        const r = state.rows.find((x) => x.id === id && x.owner === customerId);
        return r === undefined
          ? null
          : {
              ...r,
              productId: null,
              region: null,
              parentResourceId: null,
              createdAt: new Date(),
              deletedAt: null,
            };
      },
    },
    operations: {
      listForResource: async () =>
        state.ops.map((o, i) => ({
          id: `op-${i}`,
          resourceId: ZONE,
          step: null,
          needsApproval: false,
          ...o,
        })),
    },
  }),
}));

const { loadZone, loadZoneList, recordRelativeName } = await import("./dns-view.ts");

const session = (customerId: string) => ({ customerId }) as never;
const zone = (over: Partial<Row> = {}): Row => ({
  id: ZONE,
  owner: ALICE,
  family: "dns_zone",
  state: "active",
  config: {
    zoneName: "example.com",
    hostedZoneId: "Z000001",
    nameServers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"],
    records: [
      {
        name: "example.com",
        type: "NS",
        ttl: 172800,
        values: ["ns-1.awsdns-01.org."],
        readOnly: true,
      },
      { name: "www.example.com", type: "A", ttl: 300, values: ["203.0.113.10"] },
      { name: "example.com", type: "TXT", ttl: 300, values: ['"v=spf1 -all"'] },
    ],
  },
  ...over,
});

beforeEach(() => {
  state.rows = [zone()];
  state.ops = [];
  state.flag = true;
});

describe("recordRelativeName", () => {
  it("is @ for the apex, the label part inside the zone, and the full name otherwise", () => {
    expect(recordRelativeName("example.com", "example.com")).toBe("@");
    expect(recordRelativeName("example.com", "www.example.com")).toBe("www");
    expect(recordRelativeName("example.com", "a.b.example.com")).toBe("a.b");
    expect(recordRelativeName("example.com", "other.org")).toBe("other.org");
  });
});

describe("loadZoneList", () => {
  it("lists the session's zones only (R8), with name and state and no hosted zone id", async () => {
    state.rows = [zone(), zone({ id: "0190aaaa-0000-7000-8000-0000000000d2", owner: BOB })];
    const out = await loadZoneList(session(ALICE));
    expect(out.state).toBe("ready");
    if (out.state === "ready") {
      expect(out.zones).toEqual([
        { id: ZONE, name: "example.com", state: "active", recordCount: 2 },
      ]);
      expect(JSON.stringify(out)).not.toMatch(/Z000001|awsdns/);
    }
  });
  it("is empty without a zone, leaves out other families and destroyed zones", async () => {
    state.rows = [zone({ family: "linux_instance" }), zone({ state: "destroyed" })];
    expect(await loadZoneList(session(ALICE))).toEqual({ state: "empty" });
  });
  it("is flag_off with the flag off or unreadable (R12, R16)", async () => {
    state.flag = false;
    expect(await loadZoneList(session(ALICE))).toEqual({ state: "flag_off" });
    state.flag = undefined;
    expect(await loadZoneList(session(ALICE))).toEqual({ state: "flag_off" });
  });
  it("skips a zone whose stored name is not a zone name", async () => {
    state.rows = [zone({ config: { zoneName: "not a zone" } })];
    expect(await loadZoneList(session(ALICE))).toEqual({ state: "empty" });
  });
});

describe("loadZone", () => {
  it("shows the records without the trailing dots, the apex NS read-only and TXT as typed", async () => {
    const out = await loadZone(session(ALICE), ZONE, "req-1");
    expect(out?.state).toBe("ready");
    if (out?.state === "ready") {
      expect(out.zone.name).toBe("example.com");
      expect(out.zone.nameServers).toEqual(["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"]);
      expect(out.zone.records?.map((r) => [r.relative, r.type, r.readOnly])).toEqual([
        ["@", "NS", true],
        ["@", "TXT", false],
        ["www", "A", false],
      ]);
      expect(out.zone.records?.find((r) => r.type === "TXT")?.values).toEqual(["v=spf1 -all"]);
      expect(out.zone.requestId).toBe("req-1");
      expect(JSON.stringify(out)).not.toMatch(/Z000001/);
    }
  });
  it("answers null for another customer's zone like for a missing one (R8)", async () => {
    expect(await loadZone(session(BOB), ZONE, "r")).toBeNull();
    expect(await loadZone(session(ALICE), "0190aaaa-0000-7000-8000-0000000000ee", "r")).toBeNull();
    state.rows = [zone({ family: "linux_instance" })];
    expect(await loadZone(session(ALICE), ZONE, "r")).toBeNull();
  });
  it("is flag_off with the flag off", async () => {
    state.flag = false;
    expect(await loadZone(session(ALICE), ZONE, "r")).toEqual({ state: "flag_off" });
  });
  it("shows no records when the list is stale or malformed, and says so (R16)", async () => {
    state.rows = [
      zone({ config: { zoneName: "example.com", hostedZoneId: "Z1", recordsStale: true } }),
    ];
    const stale = await loadZone(session(ALICE), ZONE, "r");
    expect(stale?.state === "ready" && stale.zone.records).toBeNull();
    expect(stale?.state === "ready" && stale.zone.recordsStale).toBe(true);
    state.rows = [zone({ config: { zoneName: "example.com", hostedZoneId: "Z1", records: "no" } })];
    const bad = await loadZone(session(ALICE), ZONE, "r");
    expect(bad?.state === "ready" && bad.zone.records).toBeNull();
  });
  it("has an empty list for a zone that was never changed (the first change fills it)", async () => {
    state.rows = [zone({ config: { zoneName: "example.com", hostedZoneId: "Z1" } })];
    const out = await loadZone(session(ALICE), ZONE, "r");
    expect(out?.state === "ready" && out.zone.records).toEqual([]);
    expect(out?.state === "ready" && out.zone.canEdit).toBe(true);
  });
  it("cannot be edited while a change is on its way, while not active or without a hosted zone", async () => {
    state.ops = [{ kind: "change_dns_record", state: "running", createdAt: new Date() }];
    let out = await loadZone(session(ALICE), ZONE, "r");
    expect(out?.state === "ready" && out.zone.busy).toBe(true);
    expect(out?.state === "ready" && out.zone.canEdit).toBe(false);
    state.ops = [];
    state.rows = [zone({ state: "creating" })];
    out = await loadZone(session(ALICE), ZONE, "r");
    expect(out?.state === "ready" && out.zone.canEdit).toBe(false);
    state.rows = [zone({ config: { zoneName: "example.com" } })];
    out = await loadZone(session(ALICE), ZONE, "r");
    expect(out?.state === "ready" && out.zone.canEdit).toBe(false);
  });
  it("reports the latest change as a state word: working, done or failed", async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 10, 12, 1, 0, s));
    state.ops = [
      { kind: "change_dns_record", state: "failed", createdAt: t(2) },
      { kind: "change_dns_record", state: "succeeded", createdAt: t(1) },
      { kind: "reboot", state: "queued", createdAt: t(3) },
    ];
    const out = await loadZone(session(ALICE), ZONE, "r");
    expect(out?.state === "ready" && out.zone.lastChange).toBe("failed");
    state.ops = [];
    const none = await loadZone(session(ALICE), ZONE, "r");
    expect(none?.state === "ready" && none.zone.lastChange).toBeNull();
  });
});
