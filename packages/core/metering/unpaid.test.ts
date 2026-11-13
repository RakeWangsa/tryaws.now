import type {
  LifecycleRow,
  ResourceOpRow,
  SubscriptionStatus,
  Tx,
  UnpaidResourceRow,
} from "@tc/db";
import { describe, expect, it } from "vitest";
import type { Notice } from "../lifecycle/notice";
import { R13_APPROVAL_UNTIL } from "../lifecycle/unpaid";
import type { PostTransactionInput } from "../ledger/types";
import { createMemoryQueue } from "../operations/queue";
import type { ChargeSnapshot } from "../pricing/charge-snapshot";
import type { MeteredUnitPrice } from "../pricing/metering";
import type { StaticIpPrice } from "../products/static-ip-price";
import type { ErrorCode, Result } from "../types";
import { UNPAID_PERIOD_CAP, runUnpaid, unpaidRunKey, type UnpaidOps } from "./index";
import { ipWithInputs, withInputs } from "../test/metered-inputs";

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
  periodEnd: Date;
  finalBackups: string[];
  ipPrice: StaticIpPrice | null;
  opStates: Record<string, string>;
  deletedAt: Date | null;
  /** WPU-Y3c. Operations that exist before the run (an admin suspend, a retention destroy, ...). */
  seed: Seed[];
  /** WPU-Y3c. Operations whose cancel loses the race (they started in the meantime). */
  cancelLoses: string[];
  /** WPU-Z1. The ledger refuses every new posting with this code (another reason than the wallet). */
  postError?: ErrorCode;
}

interface Seed {
  key: string;
  kind: string;
  state: string;
  approved?: boolean;
  attempts?: number;
  at?: number;
  step?: string | null;
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
    periodEnd: new Date("2026-12-20T00:00:00Z"),
    finalBackups: [],
    ipPrice: null,
    opStates: {},
    deletedAt: null,
    seed: [],
    cancelLoses: [],
    ...init,
  };
  const posted = new Map<string, PostTransactionInput>();
  const ops = new Map<
    string,
    {
      kind: string;
      state: string;
      approved: boolean;
      attempts: number;
      at: number;
      step?: string | null;
    }
  >();
  let seq = 0;
  const cancelled: string[] = [];
  w.seed.forEach((o, i) =>
    ops.set(o.key, {
      kind: o.kind,
      state: o.state,
      approved: o.approved ?? false,
      attempts: o.attempts ?? 0,
      at: o.at ?? 1000 + i,
      step: o.step ?? null,
    }),
  );
  const notices = new Map<string, Notice>();
  const keys: string[] = [];
  const calls = {
    list: 0,
    retain: 0,
    setStatus: [] as string[],
    flags: [] as string[],
    chargedQueries: 0,
    episode: undefined as number | undefined,
    balanceReads: 0,
    superseded: 0,
    clockStarts: [] as string[],
    releaseDisks: 0,
  };
  const fake: UnpaidOps = {
    enabled: async () => w.enabled,
    approvalUntil: async () => w.approvalUntil,
    list: async (_tx, after) => {
      calls.list += 1;
      const hasMark =
        (typeof w.config.unpaidSince === "string" || typeof w.config.unpaidIpFrom === "string") &&
        ["active", "stopped", "suspended"].includes(w.state);
      if (!hasMark || after !== null) return [];
      const row: UnpaidResourceRow = {
        resourceId: RES,
        customerId: CUST,
        subscriptionId: SUB,
        unpaidSince:
          typeof w.config.unpaidSince === "string" ? new Date(w.config.unpaidSince) : null,
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
        periodEnd: w.periodEnd,
        autoRenew: true,
        status: w.status,
        resource: {
          family: w.family,
          state: w.state,
          config: { ...w.config },
          deletedAt: w.deletedAt,
        },
      }) satisfies LifecycleRow,
    usage: async (_tx, _r, _m, from, to) =>
      w.usage.filter((u) => u.period >= from && u.period <= to),
    snapshotUnit: async () => (w.unit === null ? null : withInputs(w.unit)),
    staticIpPrice: async () =>
      w.ipPrice === null
        ? { ok: false, error: "not_found" }
        : { ok: true, value: ipWithInputs(w.ipPrice) },
    chargedPeriods: async (_tx, resourceId, metric, from, to) => {
      calls.chargedQueries += 1;
      const prefix = `meter:${resourceId}:${metric}:`;
      return new Set(
        [...posted.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length))
          .filter((p) => p >= from && p <= to),
      );
    },
    balance: async () => {
      calls.balanceReads += 1;
      return w.balance;
    },
    supersedeFinal: async () => {
      calls.superseded += 1;
      return w.finalBackups;
    },
    resourceOps: async (_tx, _r, kinds) =>
      [...ops.entries()]
        .filter(([, o]) => kinds.includes(o.kind as never))
        .map(([key, o]): ResourceOpRow => ({
          id: key,
          kind: o.kind,
          key,
          state: o.state,
          approved: o.approved,
          attempts: o.attempts,
          createdAtMs: o.at,
          step: o.step ?? null,
        })),
    cancel: async (_tx, id) => {
      const o = ops.get(id);
      if (
        o === undefined ||
        w.cancelLoses.includes(id) ||
        !(
          ["queued", "needs_approval"].includes(o.state) ||
          (o.state === "waiting" && (o.step ?? null) === null)
        ) ||
        o.approved ||
        o.attempts > 0
      ) {
        return false;
      }
      o.state = "failed";
      cancelled.push(id);
      return true;
    },
    post: async (_tx, input): Promise<Result<{ transactionId: string }>> => {
      if (posted.has(input.idempotencyKey)) return { ok: true, value: { transactionId: "x" } };
      if (w.postError !== undefined) return { ok: false, error: w.postError };
      const wallet = input.postings.find((p) => p.account.type === "customer_wallet")!;
      if (w.balance < wallet.amountMinor) {
        return { ok: false, error: "insufficient_balance", data: { shortfallMinor: 1n } };
      }
      w.balance -= wallet.amountMinor;
      posted.set(input.idempotencyKey, input);
      return { ok: true, value: { transactionId: "x" } };
    },
    clear: async () => {
      for (const k of [
        "unpaidSince",
        "unpaidSuspended",
        "unpaidRetained",
        "unpaidRetainedFrom",
        "unpaidIpFrom",
        "unpaidIpTo",
        "unpaidDayFrom",
      ])
        delete w.config[k];
    },
    startClock: async (_tx, _r, at) => {
      calls.clockStarts.push(at.toISOString());
      if (w.config.unpaidSince === undefined) w.config.unpaidSince = at.toISOString();
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
          state: w.opStates[input.key] ?? existing.state,
        };
      const state =
        input.kind === "destroy" && w.approvalUntil && NOW < w.approvalUntil
          ? "needs_approval"
          : "queued";
      seq += 1;
      ops.set(input.key, {
        kind: input.kind,
        state,
        approved: false,
        attempts: 0,
        at: Date.now() + seq,
      });
      keys.push(input.key);
      return { operationId: "0190e000-0000-7000-8000-000000000001", created: true, state };
    },
    setStatus: async (_tx, _s, status) => {
      calls.setStatus.push(status);
      w.status = status;
    },
    releaseDisks: async () => {
      calls.releaseDisks += 1;
    },
    retain: async (_tx, row, _now, episode) => {
      calls.retain += 1;
      calls.episode = episode;
      w.status = "retained";
      seq += 1;
      ops.set(`lifecycle:final-snapshot:${row.id}`, {
        kind: "final_snapshot",
        state: "queued",
        approved: false,
        attempts: 0,
        at: Date.now() + seq,
      });
      ops.set(`lifecycle:destroy:${row.id}`, {
        kind: "destroy",
        state: w.approvalUntil && NOW < w.approvalUntil ? "needs_approval" : "queued",
        approved: false,
        attempts: 0,
        at: Date.now() + seq,
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
  return { w, run, posted, ops, notices, calls, logs, keys, cancelled };
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

  // WPU-Y9 finding 1: a retried charge carries the price inputs, so the ledger CHECK and R16 are met.
  it("saves a price snapshot with every retried snapshot-storage and static IP charge", async () => {
    const t = build({
      config: {
        unpaidSince: since(5 * HOUR),
        staticIpAttached: true,
        unpaidIpFrom: "2026-11-20T09",
        unpaidIpTo: "2026-11-20T09",
      },
      usage: days("2026-11-19", "2026-11-19"),
      ipPrice: IP,
      balance: 100_000n,
    });
    await t.run();
    const posts = [...t.posted.values()].map((p) => ({
      ...p,
      snapshot: p.priceSnapshot as ChargeSnapshot | undefined,
    }));
    expect(posts.length).toBe(2);
    for (const p of posts) {
      expect(p.snapshot?.kind).toBe("metered");
      expect(p.snapshot?.totalMinor).toBe(
        p.postings
          .filter((x) => x.account.type === "customer_wallet")
          .reduce((a, x) => a + x.amountMinor, 0n)
          .toString(),
      );
    }
    expect(posts.map((p) => p.snapshot?.meter?.metric).sort()).toEqual([
      "snapshot_gb",
      "static_ip_hour",
    ]);
  });

  // WPU-Y9 finding 4: a held day that failed for a low balance during a catch-up is older than since - 2 days.
  it("retries from the oldest unpaid day kept in the mark, older than the catch-up before the first failure", async () => {
    const t = build({
      config: { unpaidSince: since(1 * DAY), unpaidDayFrom: "2026-11-12" },
      usage: days("2026-11-12", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.charged).toBe(8);
    expect([...t.posted.keys()].sort()[0]).toBe(`meter:${RES}:snapshot_gb:2026-11-12`);
    expect(t.w.config.unpaidDayFrom).toBeUndefined(); // the episode ended: the mark goes with it
  });

  it("without the day in the mark the retry starts two days before the first failure (as before)", async () => {
    const t = build({
      config: { unpaidSince: since(1 * DAY) },
      usage: days("2026-11-12", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect([...t.posted.keys()].sort()[0]).toBe(`meter:${RES}:snapshot_gb:2026-11-17`);
  });

  it("refuses to retry when the day in the mark cannot be read (R16)", async () => {
    const t = build({
      config: { unpaidSince: since(1 * DAY), unpaidDayFrom: "yesterday" },
      usage: days("2026-11-12", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.blocked).toBe(1);
    expect(t.posted.size).toBe(0);
  });

  it("keeps the per run cap with a long mark: the rest is charged the next run", async () => {
    const t = build({
      config: { unpaidSince: since(1 * DAY), unpaidDayFrom: "2026-01-01" },
      usage: days("2026-01-01", "2026-11-19"),
      balance: 10_000_000n,
    });
    const first = await t.run();
    expect(first.charged).toBe(UNPAID_PERIOD_CAP);
    expect(first.capped).toBe(1);
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
      config: {
        unpaidSince: since(9 * DAY),
        unpaidSuspended: true,
        unpaidRetained: true,
        unpaidRetainedFrom: "active",
      },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.calls.setStatus).toEqual(["active"]);
    expect(t.calls.retain).toBe(0);
    // WPU-Y4 fix round 2: the disks retained with the server are given back in the same transaction.
    expect(t.calls.releaseDisks).toBe(1);
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
    expect(t.calls.releaseDisks).toBe(0);
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
const sinceMs = (iso: string): number => Date.parse(iso);
const IP: StaticIpPrice = {
  unit: "hour",
  perHourMinor: 77n,
  breakdown: {
    totalMinor: 77n,
    baseMinor: 64n,
    steps: [{ code: "bd_vat", amountMinor: 13n }],
  },
};

// WPU-Y3b, finding 1 (HIGH).
describe("the paid path resumes only a subscription that is active and not past its period end", () => {
  it("keeps the suspension while the renewal itself is unpaid (grace), and ends the episode", async () => {
    const t = build({
      state: "suspended",
      status: "grace",
      config: { unpaidSince: since(3 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.paid).toBe(1);
    expect(report.resumed).toBe(0);
    expect(t.ops.size).toBe(0);
    expect(t.w.config.unpaidSince).toBeUndefined();
  });

  it("keeps the suspension when the period end is already past", async () => {
    const t = build({
      state: "suspended",
      periodEnd: new Date(NOW.getTime() - HOUR),
      config: { unpaidSince: since(3 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.resumed).toBe(0);
    expect(t.ops.size).toBe(0);
  });

  it("resumes a resource that the renewal flow left suspended (it skipped the resume during the episode)", async () => {
    const t = build({
      state: "suspended",
      config: { unpaidSince: since(3 * DAY) }, // not flagged: suspended by the grace of an earlier period
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.resumed).toBe(1);
    expect([...t.ops.values()].map((o) => o.kind)).toEqual(["resume"]);
  });

  it("restores the status the subscription had before the job retained it", async () => {
    for (const from of ["active", "grace"] as const) {
      const t = build({
        state: "suspended",
        status: "retained",
        config: {
          unpaidSince: since(9 * DAY),
          unpaidSuspended: true,
          unpaidRetained: true,
          unpaidRetainedFrom: from,
        },
        usage: days("2026-11-10", "2026-11-19"),
        balance: 100_000n,
      });
      await t.run();
      expect(t.calls.setStatus).toEqual([from]);
      // grace: the renewal flow owns the resume; active with a future end: the job resumes
      expect([...t.ops.values()].map((o) => o.kind)).toEqual(from === "active" ? ["resume"] : []);
    }
  });

  it("restores to grace when the stored status cannot be read (R16)", async () => {
    const t = build({
      state: "suspended",
      status: "retained",
      config: {
        unpaidSince: since(9 * DAY),
        unpaidRetained: true,
        unpaidRetainedFrom: "weird",
      },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.calls.setStatus).toEqual(["grace"]);
    expect(t.ops.size).toBe(0);
  });

  it("stores the status it retains from, and the episode for the retention keys", async () => {
    const t = build({
      state: "suspended",
      status: "grace",
      config: { unpaidSince: since(7 * DAY), unpaidSuspended: true },
      usage: days("2026-11-10", "2026-11-19"),
    });
    await t.run();
    expect(t.calls.flags).toContain("unpaidRetainedFrom=grace");
    expect(t.calls.episode).toBe(sinceMs(since(7 * DAY)));
  });
});

// Finding 2 (HIGH), the unpaid side: a resumed resource can be suspended again in the same episode.
describe("the suspend key changes after a resume (finding 2)", () => {
  it("suspends again on a later day of the same episode, once for each day", async () => {
    const t = build({
      config: { unpaidSince: since(2 * DAY) },
      usage: days("2026-11-15", "2026-11-19"),
    });
    await t.run();
    expect(t.keys.filter((k) => k.startsWith("unpaid:suspend:"))).toHaveLength(1);
    await t.run(new Date(NOW.getTime() + HOUR)); // same day: a replay
    expect(t.keys.filter((k) => k.startsWith("unpaid:suspend:"))).toHaveLength(1);
    // an admin (or anything else) resumed it; the next unpaid day suspends it again
    t.w.state = "active";
    await t.run(new Date(NOW.getTime() + DAY));
    const suspends = t.keys.filter((k) => k.startsWith("unpaid:suspend:"));
    expect(suspends).toHaveLength(2);
    expect(new Set(suspends).size).toBe(2);
  });
});

// Finding 3 (MEDIUM).
// WPU-Y9: hours held because of a stale rate carry no clock. Nobody is suspended or told because of the
// platform's rate; the clock starts at the first charge that fails for insufficient_balance.
describe("held static IP hours without the unpaid clock", () => {
  const H = (h: string): string => `meter:${RES}:static_ip_hour:${h}`;
  const heldConfig = () => ({
    staticIpAttached: true,
    unpaidIpFrom: "2026-11-20T01",
    unpaidIpTo: "2026-11-20T11",
  });
  it("rate refreshed and the wallet sufficient: hours charged, no suspension, no email, marks gone", async () => {
    const t = build({ ipPrice: IP, config: heldConfig(), usage: [], balance: 1_000_000n });
    const report = await t.run();
    expect(report.paid).toBe(1);
    expect(report.charged).toBe(11);
    expect(t.posted.has(H("2026-11-20T01"))).toBe(true);
    expect(t.ops.size).toBe(0);
    expect(t.notices.size).toBe(0);
    expect(t.calls.clockStarts).toEqual([]);
    expect(t.w.config.unpaidSince).toBeUndefined();
    expect(t.w.config.unpaidIpFrom).toBeUndefined();
  });

  it("rate still missing: blocked, no clock, no message", async () => {
    const t = build({ ipPrice: null, config: heldConfig(), usage: [], balance: 1_000_000n });
    const report = await t.run();
    expect(report.blocked).toBe(1);
    expect(t.calls.clockStarts).toEqual([]);
    expect(t.w.config.unpaidSince).toBeUndefined();
    expect(t.ops.size + t.notices.size + t.posted.size).toBe(0);
  });

  it("rate refreshed and the wallet short: the clock starts at the first insufficient_balance, day 0 is a warning only", async () => {
    const t = build({ ipPrice: IP, config: heldConfig(), usage: [], balance: 100n });
    const report = await t.run();
    expect(t.calls.clockStarts).toEqual([NOW.toISOString()]);
    expect(t.w.config.unpaidSince).toBe(NOW.toISOString());
    expect(report.stillUnpaid).toBe(1);
    expect(t.ops.size).toBe(0); // not suspended: the clock is at day 0
    expect([...t.notices.values()].map((n) => n.template)).toEqual(["unpaid_warning"]);
  });
});

// WPU-Z1 (requirement 5). Only a charge that the wallet cannot pay (insufficient_balance) starts the unpaid clock or
// moves a customer toward suspension or deletion. A charge that cannot be priced (no price in force, the rate or not),
// or that the ledger refuses for another reason, decides nothing at any stage of the clock: no clock, no suspension,
// no retention, no message. The job already refuses such a run ("blocked"); this pins it.
describe("a charge that cannot be priced or posted for another reason than the wallet (WPU-Z1)", () => {
  const heldHours = () => ({
    staticIpAttached: true,
    unpaidIpFrom: "2026-11-20T01",
    unpaidIpTo: "2026-11-20T03",
  });
  const cases: [string, Partial<World>][] = [
    [
      "held hours without a clock, the ledger refuses the posting (conflict)",
      { config: heldHours(), ipPrice: IP, postError: "conflict", balance: 1_000_000n },
    ],
    [
      "clock at day 3 (the suspension stage), the ledger refuses the posting (internal)",
      {
        config: { unpaidSince: since(3 * DAY) },
        usage: days("2026-11-15", "2026-11-19"),
        postError: "internal",
        balance: 1_000_000n,
      },
    ],
    [
      "clock at day 8 (the deletion stage), the static IP hours have no price in force",
      { config: { unpaidSince: since(8 * DAY), ...heldHours() }, ipPrice: null, balance: 0n },
    ],
    [
      "clock at day 8 (the deletion stage), snapshot storage has no price",
      {
        config: { unpaidSince: since(8 * DAY) },
        usage: days("2026-11-10", "2026-11-19"),
        unit: null,
        balance: 0n,
      },
    ],
  ];

  it.each(cases)("%s: no clock, no suspension, no retention, no message", async (_name, init) => {
    const t = build(init);
    const clockBefore = t.w.config.unpaidSince;
    const report = await t.run();
    expect(report.blocked).toBe(1);
    expect(report).toMatchObject({ suspended: 0, retained: 0, noticed: 0, paid: 0 });
    expect(t.calls.clockStarts).toEqual([]);
    expect(t.w.config.unpaidSince).toBe(clockBefore);
    expect(t.calls.flags).toEqual([]);
    expect(t.calls.retain).toBe(0);
    expect(t.calls.setStatus).toEqual([]);
    expect(t.ops.size + t.notices.size + t.posted.size).toBe(0);
  });
});

describe("the unpaid static IP hours stay in the mark (finding 3)", () => {
  const H = (h: string): string => `meter:${RES}:static_ip_hour:${h}`;
  const ipConfig = () => ({
    unpaidSince: since(5 * HOUR),
    staticIpAttached: true,
    unpaidIpFrom: "2026-11-20T09",
    unpaidIpTo: "2026-11-20T11",
  });
  it("retries the marked hours although the IP is attached again", async () => {
    const t = build({
      ipPrice: IP,
      config: ipConfig(),
      usage: [],
      balance: 10_000n,
    });
    const report = await t.run();
    expect([...t.posted.keys()].sort()).toEqual([
      H("2026-11-20T09"),
      H("2026-11-20T10"),
      H("2026-11-20T11"),
    ]);
    expect(report.paid).toBe(1);
    expect(t.w.config.unpaidIpFrom).toBeUndefined();
  });

  it("is not paid until those hours are charged", async () => {
    const t = build({
      ipPrice: IP,
      config: ipConfig(),
      usage: [],
      balance: 100n,
    });
    const report = await t.run();
    expect(report.charged).toBe(1);
    expect(report.paid).toBe(0);
    expect(report.stillUnpaid).toBe(1);
    expect(t.w.config.unpaidSince).toBeDefined();
  });

  it("skips the hours that were charged in the meantime", async () => {
    const t = build({
      ipPrice: IP,
      config: ipConfig(),
      usage: [],
      balance: 10_000n,
    });
    t.posted.set(H("2026-11-20T10"), {} as PostTransactionInput);
    await t.run();
    expect(t.posted.size).toBe(3);
  });

  it("an unreadable hour mark decides nothing (R16)", async () => {
    const t = build({
      ipPrice: IP,
      config: {
        unpaidSince: since(5 * HOUR),
        unpaidIpFrom: "yesterday",
        unpaidIpTo: "now",
      },
      balance: 10_000n,
    });
    const report = await t.run();
    expect(report.blocked).toBe(1);
    expect(t.posted.size + t.ops.size).toBe(0);
  });
});

// Finding 4 (MEDIUM), reworked by WPU-Y3c (security review, suspension bypass).
const OWN = (n: number) => `unpaid:suspend:${RES}:${sinceMs(since(2 * DAY))}:${n}`;

describe("a suspend of the job that has not run yet when the customer pays (WPU-Y3c, 1)", () => {
  it("cancels its own queued suspend and queues no resume", async () => {
    const t = build({
      state: "active", // the suspend is queued, not done
      seed: [{ key: OWN(1), kind: "suspend", state: "queued" }],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([OWN(1)]);
    expect(report.suspendsCancelled).toBe(1);
    expect(report.resumed).toBe(0);
    expect(t.keys.some((k) => k.startsWith("unpaid:resume:"))).toBe(false);
    expect(t.w.config.unpaidSince).toBeUndefined();
  });

  it("cancels every day's queued suspend of the episode", async () => {
    const t = build({
      state: "active",
      seed: [
        { key: OWN(1), kind: "suspend", state: "queued" },
        { key: OWN(2), kind: "suspend", state: "queued" },
      ],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.cancelled.sort()).toEqual([OWN(1), OWN(2)]);
    expect(t.ops.size).toBe(2); // the two (failed) suspends; no resume
  });

  it("queues the resume when the suspend started in the meantime (the cancel lost the race)", async () => {
    const t = build({
      state: "active",
      seed: [{ key: OWN(1), kind: "suspend", state: "queued" }],
      cancelLoses: [OWN(1)],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(report.resumed).toBe(1);
    expect(t.keys.filter((k) => k.startsWith("unpaid:resume:"))).toHaveLength(1);
  });

  it("queues the resume (after it) when its own suspend is running", async () => {
    const t = build({
      state: "active",
      seed: [{ key: OWN(1), kind: "suspend", state: "running" }],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(report.resumed).toBe(1);
  });

  it("does the same when the suspend already ran in the meantime", async () => {
    const t = build({
      state: "suspended",
      seed: [{ key: OWN(1), kind: "suspend", state: "succeeded" }],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.keys.filter((k) => k.startsWith("unpaid:resume:"))).toHaveLength(1);
  });

  it("queues no resume for a flag without a suspend (nothing to undo)", async () => {
    const t = build({
      state: "active",
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.resumed).toBe(0);
    expect(t.ops.size).toBe(0);
  });

  it("needs a subscription that is active and not past its period end, also for an unfinished suspend", async () => {
    for (const extra of [
      { status: "grace" as const },
      { periodEnd: new Date("2026-11-19T00:00:00Z") },
    ]) {
      const t = build({
        state: "active",
        seed: [{ key: OWN(1), kind: "suspend", state: "running" }],
        config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
        usage: days("2026-11-15", "2026-11-19"),
        balance: 100_000n,
        ...extra,
      });
      const report = await t.run();
      expect(report.resumed).toBe(0);
      expect(t.keys.some((k) => k.startsWith("unpaid:resume:"))).toBe(false);
      expect(t.w.config.unpaidSince).toBeUndefined();
    }
  });
});

describe("another suspend of the resource is never undone by the payment (WPU-Y3c, 1)", () => {
  // a fresh config for each test: the fake world edits it
  const base = () => ({
    config: { unpaidSince: since(2 * DAY), unpaidSuspended: true } as Record<string, unknown>,
    usage: days("2026-11-15", "2026-11-19"),
    balance: 100_000n,
  });
  const admin = (state: string) => ({
    key: "abuse-suspend:0190c000-0000-7000-8000-000000000001",
    kind: "suspend",
    state,
  });

  it("an admin suspend that is queued: own queued suspend is cancelled, no resume", async () => {
    const t = build({
      ...base(),
      state: "active",
      seed: [{ key: OWN(1), kind: "suspend", state: "queued" }, admin("queued")],
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([OWN(1)]);
    expect(report.resumed).toBe(0);
    expect(t.keys.some((k) => k.startsWith("unpaid:resume:"))).toBe(false);
  });

  it.each(["queued", "running", "waiting", "needs_attention"])(
    "an admin suspend that is %s blocks the resume of a suspended resource",
    async (state) => {
      const t = build({ ...base(), state: "suspended", seed: [admin(state)] });
      const report = await t.run();
      expect(report.resumed).toBe(0);
      expect(t.ops.size).toBe(1);
      expect(t.w.config.unpaidSince).toBeUndefined();
    },
  );

  it("an admin suspend that is done and not resumed blocks the resume", async () => {
    const t = build({ ...base(), state: "suspended", seed: [admin("succeeded")] });
    expect((await t.run()).resumed).toBe(0);
  });

  it("an admin suspend that was resumed afterwards does not block", async () => {
    const t = build({
      ...base(),
      state: "suspended",
      seed: [
        { ...admin("succeeded"), at: 10 },
        { key: "abuse-resume:1", kind: "resume", state: "succeeded", at: 20 },
      ],
    });
    expect((await t.run()).resumed).toBe(1);
  });

  it("a resume that is older than the admin suspend does not lift it", async () => {
    const t = build({
      ...base(),
      state: "suspended",
      seed: [
        { key: "abuse-resume:1", kind: "resume", state: "succeeded", at: 10 },
        { ...admin("succeeded"), at: 20 },
      ],
    });
    expect((await t.run()).resumed).toBe(0);
  });

  it("a failed admin suspend does not block", async () => {
    const t = build({ ...base(), state: "suspended", seed: [admin("failed")] });
    expect((await t.run()).resumed).toBe(1);
  });

  it("a queued lifecycle suspend blocks; a done one (the grace of an earlier period) does not", async () => {
    const life = (state: string) => ({
      key: `lifecycle:suspend:${SUB}:2026-11-01T00:00:00.000Z`,
      kind: "suspend",
      state,
    });
    const blocked = build({ ...base(), state: "suspended", seed: [life("queued")] });
    expect((await blocked.run()).resumed).toBe(0);
    const free = build({ ...base(), state: "suspended", seed: [life("succeeded")] });
    expect((await free.run()).resumed).toBe(1);
  });

  it("a suspend of an unknown origin that is done and not resumed blocks (R16)", async () => {
    const t = build({
      ...base(),
      state: "suspended",
      seed: [{ key: "something:else", kind: "suspend", state: "succeeded" }],
    });
    expect((await t.run()).resumed).toBe(0);
  });

  it("never cancels a suspend that is not its own", async () => {
    const t = build({ ...base(), state: "active", seed: [admin("queued")] });
    await t.run();
    expect(t.cancelled).toEqual([]);
  });

  it("the cancel of its own suspend is a replay on a second run (R7)", async () => {
    const t = build({
      ...base(),
      state: "active",
      seed: [{ key: OWN(1), kind: "suspend", state: "queued" }],
    });
    await t.run();
    // the episode is cleared; a second run finds nothing to do
    const again = await t.run();
    expect(again.examined).toBe(0);
    expect(t.cancelled).toEqual([OWN(1)]);
  });
});

// Finding 5 (MEDIUM), reworked by WPU-Y3c (security review, R13).
const FINAL = "0190f000-0000-7000-8000-000000000001";
const retainedPaid = (extra: Partial<World> = {}) =>
  build({
    state: "suspended",
    status: "retained",
    finalBackups: [FINAL],
    config: {
      unpaidSince: since(9 * DAY),
      unpaidSuspended: true,
      unpaidRetained: true,
      unpaidRetainedFrom: "active",
    },
    usage: days("2026-11-10", "2026-11-19"),
    balance: 100_000n,
    ...extra,
  });
const DESTROY = `lifecycle:destroy:${SUB}:2026-12-20T00:00:00.000Z`;
const DESTROY_SALTED = `${DESTROY}:u${sinceMs(since(9 * DAY))}`;

describe("the final snapshot after a payment that came after day 7 (WPU-Y3c, 2)", () => {
  it("never queues a delete_backup: the deletion is left to the customer or an approved admin", async () => {
    const t = retainedPaid();
    const report = await t.run();
    expect(t.keys.some((k) => k.startsWith("unpaid:final-delete:"))).toBe(false);
    expect([...t.ops.values()].some((o) => o.kind === "delete_backup")).toBe(false);
    expect(report.finalReleased).toBe(1);
  });

  it("with no destroy at all (never ran): the flag is cleared", async () => {
    const t = retainedPaid();
    await t.run();
    expect(t.calls.superseded).toBe(1);
  });

  it.each([
    ["needs_approval", "waiting for an admin"],
    ["queued", "queued after the R13 date"],
  ])("a destroy that is %s (%s) is cancelled first, then the flag is cleared", async (state) => {
    const t = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state }] });
    const report = await t.run();
    expect(t.cancelled).toEqual([DESTROY]);
    expect(t.calls.superseded).toBe(1);
    expect(report.finalReleased).toBe(1);
    expect(report.finalHeld).toBe(0);
  });

  it("looks at the episode-salted destroy too", async () => {
    const t = retainedPaid({
      seed: [
        { key: DESTROY, kind: "destroy", state: "failed" },
        { key: DESTROY_SALTED, kind: "destroy", state: "succeeded" },
      ],
    });
    const report = await t.run();
    expect(t.calls.superseded).toBe(0);
    expect(report.finalHeld).toBe(1);
  });

  it.each([
    ["running", null, 0],
    ["waiting", "wait_server", 0],
    ["waiting", null, 1],
    ["succeeded", null, 0],
    ["needs_attention", null, 0],
  ])(
    "a destroy that is %s (step %s, attempts %d) stops it: the flag stays, nothing is deleted",
    async (state, step, attempts) => {
      const t = retainedPaid({
        seed: [{ key: DESTROY, kind: "destroy", state, step, attempts }],
      });
      const report = await t.run();
      expect(t.cancelled).toEqual([]);
      expect(t.calls.superseded).toBe(0);
      expect(report.finalReleased).toBe(0);
      expect(report.finalHeld).toBe(1);
      expect(t.keys.some((k) => k.startsWith("unpaid:final-delete:"))).toBe(false);
    },
  );

  it("a destroy held back by the claim's block rule (waiting, no step, never attempted) is cancelled, then the flag is cleared (WPU-X1 fix round 2)", async () => {
    const t = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state: "waiting" }] });
    const report = await t.run();
    expect(t.cancelled).toEqual([DESTROY]);
    expect(t.calls.superseded).toBe(1);
    expect(report.finalReleased).toBe(1);
    expect(report.finalHeld).toBe(0);
  });

  it("a blocked waiting destroy that an admin approved still stops it", async () => {
    const t = retainedPaid({
      seed: [{ key: DESTROY, kind: "destroy", state: "waiting", approved: true }],
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(report.finalHeld).toBe(1);
  });

  it("an approved destroy stops it, even when it is only queued", async () => {
    const t = retainedPaid({
      seed: [{ key: DESTROY, kind: "destroy", state: "queued", approved: true }],
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(t.calls.superseded).toBe(0);
    expect(report.finalHeld).toBe(1);
  });

  it("a destroy that failed after it ran stops it (partial destroy, R16)", async () => {
    const t = retainedPaid({
      seed: [{ key: DESTROY, kind: "destroy", state: "failed", attempts: 2 }],
    });
    const report = await t.run();
    expect(t.calls.superseded).toBe(0);
    expect(report.finalHeld).toBe(1);
  });

  it("a destroy that failed without ever running (or was cancelled) lets it go on", async () => {
    const t = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state: "failed" }] });
    const report = await t.run();
    expect(t.calls.superseded).toBe(1);
    expect(report.finalReleased).toBe(1);
  });

  it("a destroy whose cancel loses the race stops it", async () => {
    const t = retainedPaid({
      seed: [{ key: DESTROY, kind: "destroy", state: "queued" }],
      cancelLoses: [DESTROY],
    });
    const report = await t.run();
    expect(t.calls.superseded).toBe(0);
    expect(report.finalHeld).toBe(1);
  });

  it("a resource in a state that is not live is not touched", async () => {
    const t = retainedPaid({ state: "destroyed" });
    await t.run();
    expect(t.calls.superseded).toBe(0);
  });

  it("stops when the resource has a deletion time", async () => {
    const t = retainedPaid({ deletedAt: new Date("2026-11-19T00:00:00Z") });
    const report = await t.run();
    expect(t.calls.superseded).toBe(0);
    expect(report.finalHeld).toBe(1);
  });

  it("still ends the episode and restores the status when it is held", async () => {
    const t = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state: "running" }] });
    await t.run();
    expect(t.calls.setStatus).toEqual(["active"]);
    expect(t.w.config.unpaidSince).toBeUndefined();
  });

  it("a second run does nothing new", async () => {
    const t = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state: "needs_approval" }] });
    await t.run();
    const again = await t.run();
    expect(again.examined).toBe(0);
    expect(t.cancelled).toEqual([DESTROY]);
  });

  it("does nothing for a subscription that was not retained by this job", async () => {
    const t = build({
      state: "suspended",
      status: "active",
      finalBackups: [FINAL],
      config: { unpaidSince: since(2 * DAY), unpaidSuspended: true },
      usage: days("2026-11-15", "2026-11-19"),
      balance: 100_000n,
    });
    await t.run();
    expect(t.calls.superseded).toBe(0);
    expect(t.keys.some((k) => k.startsWith("unpaid:final-delete:"))).toBe(false);
  });
});

// WPU-X1: the server's own final snapshot at the payback. One that never started is ended with the retention (it
// would make a billed snapshot nobody asked for); one that started finishes as an ordinary backup (the db rule of
// ensureFinalBackup and markFinalBackup); the ids of the ended ones are logged (R14: ids and fixed words only).
describe("the server's own final snapshot at the payback (WPU-X1)", () => {
  const SNAP = `lifecycle:final-snapshot:${SUB}:2026-12-20T00:00:00.000Z`;

  it("one that never started is cancelled, and its id is logged", async () => {
    const t = retainedPaid({ seed: [{ key: SNAP, kind: "final_snapshot", state: "queued" }] });
    const report = await t.run();
    expect(t.cancelled).toEqual([SNAP]);
    expect(report.finalReleased).toBe(1);
    expect(t.logs).toContainEqual({
      event: "unpaid",
      action: "final_snapshot_ended",
      resourceId: RES,
      operationId: SNAP,
    });
  });

  it.each([
    ["running", null, 1],
    ["waiting", "wait_snapshot", 1],
    ["needs_attention", "wait_snapshot", 1],
    ["queued", null, 2],
    ["queued", "wait_snapshot", 0],
  ])("one that started (%s, step %s, attempts %d) is left to finish", async (state, step, n) => {
    const t = retainedPaid({
      seed: [{ key: SNAP, kind: "final_snapshot", state, step, attempts: n }],
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(t.ops.get(SNAP)?.state).toBe(state);
    // The release itself goes on: the finished snapshot is an ordinary backup.
    expect(t.calls.superseded).toBe(1);
    expect(report.finalReleased).toBe(1);
    expect(t.logs.some((l) => (l as { action?: string }).action === "final_snapshot_ended")).toBe(
      false,
    );
  });

  it("one blocked behind another operation (waiting, no step, never attempted) is cancelled (fix round 1)", async () => {
    const t = retainedPaid({ seed: [{ key: SNAP, kind: "final_snapshot", state: "waiting" }] });
    await t.run();
    expect(t.cancelled).toEqual([SNAP]);
  });

  it("one that started, with no backup row yet to release, still gets the released notice (fix round 1)", async () => {
    const t = retainedPaid({
      finalBackups: [],
      seed: [{ key: SNAP, kind: "final_snapshot", state: "running", attempts: 1 }],
    });
    await t.run();
    expect(
      [...t.notices.values()].filter((n) => n.template === "unpaid_snapshot_released"),
    ).toHaveLength(1);
  });

  it("one whose cancel loses the race (it was claimed) is left to finish", async () => {
    const t = retainedPaid({
      seed: [{ key: SNAP, kind: "final_snapshot", state: "queued" }],
      cancelLoses: [SNAP],
    });
    const report = await t.run();
    expect(t.cancelled).toEqual([]);
    expect(t.calls.superseded).toBe(1);
    expect(report.finalReleased).toBe(1);
  });

  it("is not touched when the release is held (a destroy ran: the snapshot stays final)", async () => {
    const t = retainedPaid({
      seed: [
        { key: SNAP, kind: "final_snapshot", state: "queued" },
        { key: DESTROY, kind: "destroy", state: "running" },
      ],
    });
    await t.run();
    expect(t.cancelled).toEqual([]);
    expect(t.calls.superseded).toBe(0);
  });
});

describe("the customer is told once that the former final snapshot is billed (WPU-Y10)", () => {
  const released = (t: ReturnType<typeof retainedPaid>) =>
    [...t.notices.values()].filter((n) => n.template === "unpaid_snapshot_released");

  it("writes one notice, with the episode in the key, when a snapshot is released", async () => {
    const t = retainedPaid();
    const report = await t.run();
    const list = released(t);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      template: "unpaid_snapshot_released",
      data: { resourceId: RES, product: "instance" },
      dedupeKey: `unpaid:final-released:${RES}:${sinceMs(since(9 * DAY))}`,
    });
    expect(report.finalReleased).toBe(1);
  });

  it("writes none when the snapshot is held, or when there was nothing to release", async () => {
    const held = retainedPaid({ seed: [{ key: DESTROY, kind: "destroy", state: "succeeded" }] });
    await held.run();
    expect(released(held)).toHaveLength(0);
    const none = retainedPaid({ finalBackups: [] });
    await none.run();
    expect(released(none)).toHaveLength(0);
  });
});

// Finding 6 (MEDIUM, cost).
describe("bounded work for each run (finding 6)", () => {
  const long = (n: number) => {
    const first = new Date(Date.parse("2026-11-19") - (n - 1) * DAY).toISOString().slice(0, 10);
    return days(first, "2026-11-19");
  };

  it("asks the ledger once for all charged days, not once for each day", async () => {
    const t = build({
      config: { unpaidSince: since(30 * DAY) },
      usage: long(30),
      balance: 1_000_000n,
    });
    await t.run();
    expect(t.calls.chargedQueries).toBe(1);
  });

  it("charges at most the cap of periods for each resource and run, oldest first, and goes on the next run", async () => {
    const t = build({
      config: { unpaidSince: since(250 * DAY) },
      usage: long(252),
      balance: 10_000_000n,
    });
    const first = await t.run();
    expect(first.charged).toBe(UNPAID_PERIOD_CAP);
    expect(first.paid).toBe(0);
    expect(first.capped).toBe(1);
    const oldest = [...t.posted.keys()].map((k) => k.slice(-10)).sort()[0];
    expect(oldest).toBe(long(252)[0]!.period);
    const second = await t.run(new Date(NOW.getTime() + 20 * HOUR));
    expect(second.charged).toBe(252 - UNPAID_PERIOD_CAP);
    expect(second.paid).toBe(1);
  });

  it("after the deletion stage it does not retry while the wallet is empty, and still writes the daily message", async () => {
    const t = build({
      state: "suspended",
      status: "retained",
      config: {
        unpaidSince: since(9 * DAY),
        unpaidSuspended: true,
        unpaidRetained: true,
        unpaidRetainedFrom: "active",
      },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 0n,
    });
    const report = await t.run();
    expect(t.calls.chargedQueries).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.stillUnpaid).toBe(1);
    expect([...t.notices.values()][0]!.template).toBe("unpaid_deletion");
  });

  it("after the deletion stage it retries again once the wallet holds money", async () => {
    const t = build({
      state: "suspended",
      status: "retained",
      config: {
        unpaidSince: since(9 * DAY),
        unpaidSuspended: true,
        unpaidRetained: true,
        unpaidRetainedFrom: "active",
      },
      usage: days("2026-11-10", "2026-11-19"),
      balance: 100_000n,
    });
    const report = await t.run();
    expect(report.paid).toBe(1);
    expect(t.calls.setStatus).toEqual(["active"]);
  });
});
