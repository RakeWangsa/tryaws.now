import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderPort } from "./extras-view.ts";

// WPU-Y8: the two display reads of the reader. The cross-tenant case (R8): another customer's balancer
// or database is a row the session's repository does not return, and then the reader is not asked.

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
}));

const { loadDatabaseMetrics, loadTargetHealth } = await import("./reader-reads-view.ts");

const session = { customerId: "11111111-1111-4111-8111-111111111111" } as CustomerSession;
const ID = "0190aaaa-0000-7000-8000-0000000000a1";
const S1 = "0190aaaa-0000-7000-8000-0000000000b1";
const counts = { healthy: 1, unhealthy: 0, initial: 0, unused: 0, draining: 0, unavailable: 0 };

function reader(over: Partial<ReaderPort> = {}) {
  const seen: unknown[] = [];
  const port: ReaderPort = {
    metrics: async () => ({ ok: true, series: [] }),
    targetHealth: async (id, caller) => {
      seen.push(["health", id, caller]);
      return {
        ok: true,
        report: {
          live: true,
          checkedAt: "2026-11-13T10:00:00.000Z",
          targets: [{ targetResourceId: S1, health: "healthy", reason: null }],
          counts,
          unresolved: 2,
        },
      };
    },
    databaseMetrics: async (id, caller, range) => {
      seen.push(["db", id, caller, range]);
      return {
        ok: true,
        series: [
          {
            metric: "cpu",
            unit: "percent",
            statistic: "average",
            periodSeconds: 300,
            points: [{ at: "2026-11-13T10:00:00.000Z", value: 3 }],
          },
        ],
      };
    },
    ...over,
  };
  return { port, seen };
}

beforeEach(() => {
  state.resource = { family: "load_balancer", state: "active" };
  state.asked = [];
});

describe("loadTargetHealth", () => {
  it("is unavailable without a reader and asks nothing", async () => {
    expect(await loadTargetHealth(session, ID, new Map(), null)).toEqual({ state: "unavailable" });
    expect(state.asked).toEqual([]);
  });

  it("asks the reader with the session's customer and names servers by the customer's own names", async () => {
    const { port, seen } = reader();
    const out = await loadTargetHealth(session, ID, new Map([[S1, "web-1"]]), port);
    expect(seen).toEqual([["health", ID, { customerId: session.customerId }]]);
    expect(out).toEqual({
      state: "ready",
      checkedAt: "2026-11-13T10:00:00.000Z",
      rows: [{ id: S1, name: "web-1", health: "healthy", reason: null }],
      counts,
      unresolved: 2,
    });
  });

  it("another customer's balancer (or a missing one) is unavailable and the reader is not asked", async () => {
    state.resource = null;
    const { port, seen } = reader();
    expect(await loadTargetHealth(session, ID, new Map(), port)).toEqual({ state: "unavailable" });
    expect(seen).toEqual([]);
  });

  it("a resource of another family is not read", async () => {
    state.resource = { family: "database", state: "active" };
    const { port, seen } = reader();
    expect((await loadTargetHealth(session, ID, new Map(), port)).state).toBe("unavailable");
    expect(seen).toEqual([]);
  });

  it("a balancer that is not live is answered without asking the reader", async () => {
    state.resource = { family: "load_balancer", state: "creating" };
    const { port, seen } = reader();
    expect(await loadTargetHealth(session, ID, new Map(), port)).toEqual({ state: "not_live" });
    expect(seen).toEqual([]);
  });

  it("no target is the empty state; a failing or throwing reader is unavailable without its text", async () => {
    const none = reader({
      targetHealth: async () => ({
        ok: true,
        report: {
          live: true,
          checkedAt: "2026-11-13T10:00:00.000Z",
          targets: [],
          counts,
          unresolved: 0,
        },
      }),
    });
    expect((await loadTargetHealth(session, ID, new Map(), none.port)).state).toBe("empty");
    const failing = reader({ targetHealth: async () => ({ ok: false, error: "internal" }) });
    expect(await loadTargetHealth(session, ID, new Map(), failing.port)).toEqual({
      state: "unavailable",
    });
    const throwing = reader({
      targetHealth: async () => {
        throw new Error("arn:aws:iam::123456789012:role/x");
      },
    });
    const out = await loadTargetHealth(session, ID, new Map(), throwing.port);
    expect(JSON.stringify(out)).not.toMatch(/arn:aws|123456789012/);
  });
});

describe("loadDatabaseMetrics", () => {
  beforeEach(() => {
    state.resource = { family: "database", state: "active" };
  });

  it("asks the reader with the session's customer and the range", async () => {
    const { port, seen } = reader();
    const out = await loadDatabaseMetrics(session, ID, "1w", port);
    expect(seen).toEqual([["db", ID, { customerId: session.customerId }, "1w"]]);
    expect(out).toMatchObject({ state: "ready", range: "1w" });
  });

  it("another customer's database is unavailable and the reader is not asked", async () => {
    state.resource = null;
    const { port, seen } = reader();
    expect(await loadDatabaseMetrics(session, ID, "1h", port)).toEqual({ state: "unavailable" });
    expect(seen).toEqual([]);
  });

  it("no reader, a failure or no points give the unavailable or empty state", async () => {
    expect(await loadDatabaseMetrics(session, ID, "1h", null)).toEqual({ state: "unavailable" });
    const failing = reader({ databaseMetrics: async () => ({ ok: false, error: "rate_limited" }) });
    expect(await loadDatabaseMetrics(session, ID, "1h", failing.port)).toEqual({
      state: "unavailable",
    });
    const empty = reader({ databaseMetrics: async () => ({ ok: true, series: [] }) });
    expect(await loadDatabaseMetrics(session, ID, "1d", empty.port)).toEqual({
      state: "empty",
      range: "1d",
    });
    state.resource = { family: "database", state: "creating" };
    expect(await loadDatabaseMetrics(session, ID, "1d", reader().port)).toEqual({
      state: "empty",
      range: "1d",
    });
  });
});
