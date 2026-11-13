import type { LifecycleRow, SubscriptionStatus, Tx, UnpaidResourceRow } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { Notice } from "../lifecycle/notice";
import { R13_APPROVAL_UNTIL } from "../lifecycle/unpaid";
import type { PostTransactionInput } from "../ledger/types";
import { createMemoryQueue } from "../operations/queue";
import type { MeteredUnitPrice } from "../pricing/metering";
import type { Result } from "../types";
import { runUnpaid, unpaidRunKey, type UnpaidOps } from "./index";

// WPU-Y3. The unpaid-usage rule with a fake world (no database): retry every unpaid day without a
// window, suspend at 1 day, retain at 7 days, R13 on both sides of the date, a payment restores, and a
// second run on the same day does nothing new.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RES = "0190a000-0000-7000-8000-000000000001";
const CUST = "0190b000-0000-7000-8000-000000000001";
const SUB = "0190d000-0000-7000-8000-000000000001";
const NOW = new Date("2026-11-20T08:00:00.000Z"); // Dhaka 14:00, day 2026-11-20; last ended day 11-19

// 30 GB at 1000 paisa a GB-month is 1000 paisa a day.
const UNIT: MeteredUnitPrice = {
  totalMinor: 1000n,
  baseMinor: 850n,
  steps: [
    { code: "korea_vat", amountMinor: 100n },
    { code: "bd_vat", amountMinor: 50n },
  ],
};
const dayOf = (iso: string): string => iso.slice(0, 10);

interface World {
  state: string;
  status: SubscriptionStatus;
  config: Record<string, unknown>;
  balance: bigint;
  usage: { period: string; quantity: string }[];
  unit: MeteredUnitPrice | null;
  enabled: boolean;
  approvalUntil: Date | null;
  family: string;
}

function build(init: Partial<World> = {}) {
  const w: World = {
    state: "active",
    status: "active",
    config: {},
    balance: 0n,
    usage: [],
    unit: UNIT,
    enabled: true,
    approvalUntil: R13_APPROVAL_UNTIL,
    family: "linux_instance",
    ...init,
  };
  const posted = new Map<string, PostTransactionInput>();
  const ops = new Map<string, { kind: string; state: string }>();
  const notices = new Map<string, Notice>();
  const calls = { list: 0, retain: 0, setStatus: [] as string[], flags: [] as string[] };
  const fake: UnpaidOps = {
    enabled: async () => w.enabled,
    approvalUntil: async () => w.approvalUntil,
    list: async (_tx, after) => {
      calls.list += 1;
      const hasMark =
        typeof w.config.unpaidSince === "string" &&
        ["active", "stopped", "suspended"].includes(w.state);
      if (!hasMark || after !== null) return [];
      const row: UnpaidResourceRow = {
        resourceId: RES,
        customerId: CUST,
        subscriptionId: SUB,
        unpaidSince: new Date(w.config.unpaidSince as string),
      };
      return [row];
    },
    lock: async () =>
      ({
        id: SUB,
        resourceId: RES,
        customerId: CUST,
        market: "BD",
        termDays: 30,
        priceSnapshot: {},
        periodStart: new Date("2026-11-01T00:00:00Z"),
        periodEnd: new Date("2026-12-20T00:00:00Z"),
        autoRenew: true,
        status: w.status,
        resource: { family: w.family, state: w.state, config: { ...w.config }, deletedAt: null },
      }) satisfies LifecycleRow,
    usage: async (_tx, _r, _m, from, to) =>
      w.usage.filter((u) => u.period >= from && u.period <= to),
    snapshotUnit: async () => w.unit,
    staticIpPrice: async () => ({ ok: false, error: "not_found" }),
    hasCharge: async (_tx, key) => posted.has(key),
    post: async (_tx, input): Promise<Result<{ transactionId: string }>> => {
      if (posted.has(input.idempotencyKey)) return { ok: true, value: { transactionId: "x" } };
      const wallet = input.postings.find((p) => p.account.type === "customer_wallet")!;
      if (w.balance < wallet.amountMinor) {
        return { ok: false, error: "insufficient_balance", data: { shortfallMinor: 1n } };
      }
      w.balance -= wallet.amountMinor;
      posted.set(input.idempotencyKey, input);
      return { ok: true, value: { transactionId: "x" } };
    },
    clear: async () => {
      for (const k of ["unpaidSince", "unpaidSuspended", "unpaidRetained"]) delete w.config[k];
    },
    setFlag: async (_tx, _r, key, value) => {
      calls.flags.push(`${key}=${value}`);
      w.config[key] = value;
    },
    enqueue: async (_tx, input) => {
      const existing = ops.get(input.key);
      if (existing)
        return {
          operationId: "0190e000-0000-7000-8000-000000000001",
          created: false,
          state: existing.state,
        };
      const state =
        input.kind === "destroy" && w.approvalUntil && NOW < w.approvalUntil
          ? "needs_approval"
          : "queued";
      ops.set(input.key, { kind: input.kind, state });
      return { operationId: "0190e000-0000-7000-8000-000000000001", created: true, state };
    },
    setStatus: async (_tx, _s, status) => {
      calls.setStatus.push(status);
      w.status = status;
    },
    retain: async (_tx, row) => {
      calls.retain += 1;
      w.status = "retained";
      ops.set(`lifecycle:final-snapshot:${row.id}`, { kind: "final_snapshot", state: "queued" });
      ops.set(`lifecycle:destroy:${row.id}`, {
        kind: "destroy",
        state: w.approvalUntil && NOW < w.approvalUntil ? "needs_approval" : "queued",
      });
      return [];
    },
  };
  const logs: Record<string, unknown>[] = [];
  const run = (now: Date = NOW) =>
    runUnpaid({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => now },
      log: (e) => logs.push(e as never),
      queue: createMemoryQueue({ clock: { now: () => now } }),
      notice: async (_tx, n) => {
        notices.set(`${n.template}:${n.dedupeKey}`, n);
      },
      ops: fake,
    });
  return { w, run, posted, ops, notices, calls, logs };
}

// Every Dhaka day that ended between two ISO days, as usage rows of 30 GB.
function days(from: string, to: string): { period: string; quantity: string }[] {
  const out: { period: string; quantity: string }[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    out.push({ period: dayOf(new Date(t).toISOString()), quantity: "30" });
  }
  return out;
}
const since = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe("the switch (R12)", () => {
  it("does nothing while it is off: no list, no charge, no operation, no message", async () => {
    const t = build({
      enabled: false,
      config: { unpaidSince: since(5 * DAY) },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 10_000n,
    });
    const report = await t.run();
    expect(report.enabled).toBe(false);
    expect(t.calls.list).toBe(0);
    expect(t.posted.size).toBe(0);
    expect(t.ops.size + t.notices.size).toBe(0);
  });

  it("has a run key for each Dhaka day", () => {
    expect(unpaidRunKey(NOW)).toBe("unpaid:2026-11-20");
    expect(unpaidRunKey(new Date("2026-11-20T18:30:00Z"))).toBe("unpaid:2026-11-21");
  });
});

describe("retry of every unpaid day (no window)", () => {
  it("charges every day back to the first failure, also days older than the 3-day window", async () => {
    // first failed 5 days ago: days 11-13 (catch-up, 2 days before) to 11-19 are unpaid
    const t = build({
      config: { unpaidSince: since(5 * DAY) },
      usage: days("2026-11-13", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.charged).toBe(7);
    expect([...t.posted.keys()].sort()).toEqual(
      days("2026-11-13", "2026-11-19").map((d) => `meter:${RES}:snapshot_gb:${d.period}`),
    );
    expect(report.paid).toBe(1);
    expect(t.w.config.unpaidSince).toBeUndefined();
    expect(t.w.balance).toBe(100_000n - 7000n);
  });

  it("charges the oldest first and stops at the first day the wallet cannot pay", async () => {
    const t = build({
      config: { unpaidSince: since(3 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 2500n,
    });
    const report = await t.run();
    expect([...t.posted.keys()]).toEqual([
      `meter:${RES}:snapshot_gb:2026-11-15`,
      `meter:${RES}:snapshot_gb:2026-11-16`,
    ]);
    expect(report.charged).toBe(2);
    expect(report.stillUnpaid).toBe(1);
    expect(t.w.balance).toBe(500n);
    expect(t.w.config.unpaidSince).toBeDefined();
  });

  it("never charges a day twice: the ledger key is the same as the normal pass", async () => {
    const t = build({
      config: { unpaidSince: since(3 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    // the normal pass already charged 11-16
    t.posted.set(`meter:${RES}:snapshot_gb:2026-11-16`, {} as PostTransactionInput);
    await t.run();
    expect(t.posted.size).toBe(5);
    expect(t.w.balance).toBe(100_000n - 4000n);
  });

  it("splits the charge like a purchase (the lines add up to the wallet debit)", async () => {
    const t = build({
      config: { unpaidSince: since(DAY) },
      usage: days("2026-11-19", "2026-11-19"),
      balance: 5000n,
    });
    await t.run();
    const post = [...t.posted.values()][0]!;
    const sum = post.postings
      .filter((p) => p.account.type !== "customer_wallet")
      .reduce((a, p) => a + p.amountMinor, 0n);
    expect(sum).toBe(1000n);
  });

  it("does not decide anything when there is no price (R16)", async () => {
    const t = build({
      unit: null,
      config: { unpaidSince: since(3 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
    });
    const report = await t.run();
    expect(report.blocked).toBe(1);
    expect(t.ops.size + t.notices.size + t.posted.size).toBe(0);
  });
});

describe("no grace: suspended after 1 day, retained at 7 days", () => {
  const unpaid = (ms: number, extra: Partial<World> = {}) =>
    build({
      config: { unpaidSince: since(ms) },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 0n,
      ...extra,
    });

  it("day 0: a warning only, no suspend operation", async () => {
    const t = unpaid(HOUR);
    await t.run();
    expect([...t.notices.values()].map((n) => n.template)).toEqual(["unpaid_warning"]);
    expect([...t.ops.values()]).toEqual([]);
  });

  it("just before 1 day: still a warning, no suspension", async () => {
    const t = unpaid(DAY - 1);
    await t.run();
    expect([...t.notices.values()].map((n) => n.template)).toEqual(["unpaid_warning"]);
    expect(t.ops.size).toBe(0);
    expect(t.w.config.unpaidSuspended).toBeUndefined();
  });

  it("exactly 1 day: the resource is suspended and told, 6 days left", async () => {
    const t = unpaid(DAY);
    const report = await t.run();
    expect([...t.ops.values()].map((o) => o.kind)).toEqual(["suspend"]);
    expect(t.w.config.unpaidSuspended).toBe(true);
    expect(report.suspended).toBe(1);
    const n = [...t.notices.values()][0]!;
    expect(n.template).toBe("unpaid_suspended");
    expect(n.data).toMatchObject({ daysLeft: 6, product: "instance", resourceId: RES });
  });

  it("day 6: suspended, 1 day left; nothing is retained", async () => {
    const t = unpaid(6 * DAY + 3 * HOUR, {
      state: "suspended",
      config: { unpaidSince: since(6 * DAY + 3 * HOUR), unpaidSuspended: true },
    });
    await t.run();
    expect(t.calls.retain).toBe(0);
    expect([...t.notices.values()][0]!.data).toMatchObject({ daysLeft: 1 });
  });

  it("exactly 7 days: the subscription is retained (final snapshot and destroy are queued)", async () => {
    const t = unpaid(7 * DAY, {
      state: "suspended",
      config: { unpaidSince: since(7 * DAY), unpaidSuspended: true },
    });
    const report = await t.run();
    expect(report.retained).toBe(1);
    expect(t.calls.retain).toBe(1);
    expect(t.w.status).toBe("retained");
    expect([...t.ops.values()].map((o) => o.kind).sort()).toEqual(["destroy", "final_snapshot"]);
    expect([...t.notices.values()][0]!.template).toBe("unpaid_deletion");
  });

  it("R13 before 2026-12-01: the destroy waits for an admin and the message says so", async () => {
    const t = unpaid(7 * DAY, {
      state: "suspended",
      config: { unpaidSince: since(7 * DAY), unpaidSuspended: true },
    });
    await t.run();
    expect([...t.ops.values()].find((o) => o.kind === "destroy")!.state).toBe("needs_approval");
    expect([...t.notices.values()][0]!.data).toMatchObject({ approval: true });
  });

  it("R13 after the date: the destroy is queued alone and the message says so", async () => {
    const after = new Date(R13_APPROVAL_UNTIL.getTime() + DAY);
    const t = build({
      config: {
        unpaidSince: new Date(after.getTime() - 7 * DAY).toISOString(),
        unpaidSuspended: true,
      },
      state: "suspended",
      usage: days("2026-11-26", "2026-12-02"),
    });
    await t.run(after);
    expect([...t.notices.values()][0]!.data).toMatchObject({ approval: false });
  });

  it("an admin-suspended resource is not claimed as suspended by the job", async () => {
    const t = unpaid(2 * DAY, {
      state: "suspended",
      config: { unpaidSince: since(2 * DAY), adminSuspended: true },
    });
    await t.run();
    expect(t.w.config.unpaidSuspended).toBeUndefined();
    expect(t.ops.size).toBe(0);
  });

  it("an ended subscription is never retained again", async () => {
    const t = unpaid(8 * DAY, { status: "ended", state: "suspended" });
    await t.run();
    expect(t.calls.retain).toBe(0);
  });
});

describe("paying restores; deletion never follows a payment", () => {
  it("a payment while suspended resumes the resource and ends the episode", async () => {
    const t = build({
      state: "suspended",
      config: { unpaidSince: since(3 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.paid).toBe(1);
    expect(report.resumed).toBe(1);
    expect([...t.ops.values()].map((o) => o.kind)).toEqual(["resume"]);
    expect(t.w.config.unpaidSince).toBeUndefined();
    expect(t.notices.size).toBe(0);
  });

  it("a payment never lifts a suspension by an admin", async () => {
    const t = build({
      state: "suspended",
      config: { unpaidSince: since(3 * DAY), adminSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.ops.size).toBe(0);
  });

  it("a payment after day 7 but before the destroy puts the subscription back to active (the guard then refuses the destroy)", async () => {
    const t = build({
      state: "suspended",
      status: "retained",
      config: { unpaidSince: since(9 * DAY), unpaidSuspended: true, unpaidRetained: true },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.calls.setStatus).toEqual(["active"]);
    expect(t.calls.retain).toBe(0);
  });

  it("a subscription that was retained for another reason stays retained", async () => {
    const t = build({
      state: "suspended",
      status: "retained",
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.calls.setStatus).toEqual([]);
  });

  it("a destroyed resource is not listed and nothing happens to it", async () => {
    const t = build({
      state: "destroyed",
      config: { unpaidSince: since(9 * DAY) },
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.examined).toBe(0);
    expect(t.posted.size).toBe(0);
  });
});

describe("idempotency (R7)", () => {
  it("a second run on the same day posts, queues and writes nothing new", async () => {
    const t = build({
      config: { unpaidSince: since(2 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 1500n,
    });
    await t.run();
    const snapshot = {
      posted: [...t.posted.keys()],
      ops: [...t.ops.keys()],
      notices: [...t.notices.keys()],
      balance: t.w.balance,
    };
    await t.run();
    await t.run(new Date(NOW.getTime() + 2 * HOUR));
    expect([...t.posted.keys()]).toEqual(snapshot.posted);
    expect([...t.ops.keys()]).toEqual(snapshot.ops);
    expect([...t.notices.keys()]).toEqual(snapshot.notices);
    expect(t.w.balance).toBe(snapshot.balance);
  });

  it("sends one message for each resource and unpaid day, a new one on the next day", async () => {
    const t = build({
      config: { unpaidSince: since(2 * DAY) },
      state: "suspended",
      usage: days("2026-11-15", "2026-11-19"),
    });
    await t.run();
    await t.run(new Date(NOW.getTime() + HOUR));
    expect(t.notices.size).toBe(1);
    await t.run(new Date(NOW.getTime() + DAY));
    expect(t.notices.size).toBe(2);
  });

  it("a message holds no address, phone or AWS name", async () => {
    const t = build({
      config: { unpaidSince: since(2 * DAY) },
      state: "suspended",
      usage: days("2026-11-15", "2026-11-19"),
    });
    await t.run();
    expect(JSON.stringify([...t.notices.values()])).not.toMatch(/@|arn:|aws_name|tc-/i);
  });
});

describe("failures", () => {
  it("a row that throws is counted and logged by id and name only; the others go on", async () => {
    const t = build({
      config: { unpaidSince: since(2 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
    });
    const report = await runUnpaid({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: (e) => t.logs.push(e as never),
      ops: {
        enabled: async () => true,
        list: async () => [
          {
            resourceId: RES,
            customerId: CUST,
            subscriptionId: SUB,
            unpaidSince: new Date(since(2 * DAY)),
          },
        ],
        lock: async () => {
          throw new Error("boom with a secret value");
        },
      } as unknown as UnpaidOps,
    });
    expect(report.failed).toBe(1);
    expect(JSON.stringify(t.logs)).not.toContain("secret");
    expect(t.logs[0]).toMatchObject({
      event: "unpaid",
      action: "error",
      resourceId: RES,
      error: "Error",
    });
  });
});
