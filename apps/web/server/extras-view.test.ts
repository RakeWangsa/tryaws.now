import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resource: null as null | { family: string; state: string },
  asked: [] as string[],
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => ({
    resources: {
      get: async (id: string) => {
        state.asked.push(`${customerId}:${id}`);
        return state.resource;
      },
    },
  }),
  readFeatureFlag: async () => true,
}));

const { loadMetrics, parsePriceLines, rangeOf, toNotificationItem } =
  await import("./extras-view.ts");

const session = { customerId: "11111111-1111-4111-8111-111111111111" } as CustomerSession;
const ID = "0190aaaa-0000-7000-8000-0000000000a1";

describe("parsePriceLines (R4: bigint paisa, a breakdown that does not add up is not shown)", () => {
  const good = {
    baseMinor: "60000",
    steps: [{ code: "bd_vat", amountMinor: "9000" }],
    totalMinor: "69000",
  };
  it("reads the stored snapshot as bigint", () => {
    expect(parsePriceLines(good)).toEqual({
      baseMinor: 60000n,
      steps: [{ code: "bd_vat", amountMinor: 9000n }],
      totalMinor: 69000n,
    });
  });
  it("refuses a snapshot that does not add up, has numbers instead of text, or is not an object", () => {
    expect(parsePriceLines({ ...good, totalMinor: "69001" })).toBeNull();
    expect(parsePriceLines({ ...good, baseMinor: 60000 })).toBeNull();
    expect(parsePriceLines({ ...good, steps: [{ code: "x", amountMinor: 1.5 }] })).toBeNull();
    expect(parsePriceLines(null)).toBeNull();
    expect(parsePriceLines("{}")).toBeNull();
  });
});

describe("rangeOf", () => {
  it("accepts the three ranges and falls back to one hour", () => {
    expect(rangeOf("1d")).toBe("1d");
    expect(rangeOf("1w")).toBe("1w");
    expect(rangeOf("1y")).toBe("1h");
    expect(rangeOf(undefined)).toBe("1h");
  });
});

describe("loadMetrics (WP5-T3 reader, R8, R16)", () => {
  beforeEach(() => {
    state.resource = { family: "linux_instance", state: "active" };
    state.asked = [];
  });
  const point = { at: "2026-11-12T01:00:00Z", value: 3 };

  it("without a reader the tab is unavailable and nothing is asked", async () => {
    expect(await loadMetrics(session, ID, "1h", null)).toEqual({ state: "unavailable" });
    expect(state.asked).toEqual([]);
  });
  it("asks the reader with the customer of the session, never one from the request", async () => {
    const seen: unknown[] = [];
    const reader = {
      metrics: async (id: string, caller: { customerId: string }, range: string) => {
        seen.push([id, caller, range]);
        return {
          ok: true as const,
          series: [{ metric: "cpu" as const, unit: "percent" as const, points: [point] }],
        };
      },
    };
    const out = await loadMetrics(session, ID, "1d", reader);
    expect(out).toMatchObject({ state: "ready", range: "1d" });
    expect(seen).toEqual([[ID, { customerId: session.customerId }, "1d"]]);
  });
  it("another customer's server (or a missing one) is empty and the reader is not asked", async () => {
    state.resource = null;
    let asked = false;
    const reader = {
      metrics: async () => {
        asked = true;
        return { ok: true as const, series: [] };
      },
    };
    expect(await loadMetrics(session, ID, "1h", reader)).toEqual({ state: "empty", range: "1h" });
    expect(asked).toBe(false);
  });
  it("a reader that fails or throws gives the unavailable state without its text (U6)", async () => {
    const failing = {
      metrics: async () => ({ ok: false as const, error: "upstream_unavailable" }),
    };
    expect(await loadMetrics(session, ID, "1h", failing)).toEqual({ state: "unavailable" });
    const throwing = {
      metrics: async () => {
        throw new Error("arn:aws:iam::123456789012:role/x");
      },
    };
    expect(JSON.stringify(await loadMetrics(session, ID, "1h", throwing))).not.toMatch(/arn:aws/);
  });
  it("series without points are left out; none left is empty", async () => {
    const reader = {
      metrics: async () => ({
        ok: true as const,
        series: [{ metric: "cpu" as const, unit: "percent" as const, points: [] }],
      }),
    };
    expect(await loadMetrics(session, ID, "1w", reader)).toEqual({ state: "empty", range: "1w" });
  });
});

describe("toNotificationItem (R14)", () => {
  const ctx = {
    locale: "en",
    numerals: "latn",
    panelOrigin: "https://panel.example.test",
  } as const;
  const row = (template: string, payload: unknown) => ({
    id: ID,
    template,
    payload,
    readAt: null,
    createdAt: new Date("2026-11-12T00:00:00Z"),
  });
  it("a row that cannot be rendered shows the generic line and never its payload", () => {
    const item = toNotificationItem(row("no_such_template", { secret: "hunter2" }), ctx);
    expect(item).toMatchObject({ title: null, body: null, href: null, read: false });
    expect(JSON.stringify(item)).not.toContain("hunter2");
  });
  it("a known template with a bad payload is the generic line too", () => {
    const item = toNotificationItem(row("lifecycle_grace_started", { wrong: 1 }), ctx);
    expect(item.title).toBeNull();
  });
});
