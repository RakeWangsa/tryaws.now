import type { AdminActor, AdminRepos, Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  describeCorrection,
  makeCapacityAction,
  parseLive,
  type CapacityActionRequest,
} from "./capacity-flow.ts";

const POOL = "0191a000-0000-7000-8000-000000000001";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "ops",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");

function rig(
  over: { allow?: boolean; limit?: boolean; set?: unknown; notify?: unknown; boom?: boolean } = {},
) {
  const steps: string[] = [];
  const calls: [string, unknown, unknown][] = [];
  const repos = {
    capacity: {
      setLimit: async (input: unknown, why: string) => {
        steps.push("execute");
        calls.push(["setLimit", input, why]);
        return over.set ?? { ok: true, replayed: false, value: {} };
      },
    },
  } as unknown as AdminRepos;
  const act = makeCapacityAction({
    authorize: async (roles) => {
      steps.push("authorize");
      expect(roles).toEqual(["ops", "superadmin"]);
      if (over.allow === false) throw new Error("no");
      return ACTOR;
    },
    limiter: async () => {
      steps.push("limit");
      return over.limit !== false;
    },
    run: async (_a, fn) => {
      if (over.boom) throw new Error("db: secret");
      return fn(repos, {} as Tx);
    },
    notifyWaitlist: async (_tx, actor, input) => {
      steps.push("notify");
      calls.push(["notify", input, actor.adminId]);
      return (over.notify ?? { ok: true, value: { notified: [{}, {}] } }) as never;
    },
    clock: { now: () => NOW },
  });
  return { act, steps, calls };
}

const limit = (over: Partial<CapacityActionRequest> = {}): CapacityActionRequest => ({
  kind: "setCapacityLimit",
  reason: "AWS raised the quota",
  poolAccountId: POOL,
  region: "ap-southeast-1",
  quotaCode: "instance_vcpu",
  limit: "40",
  ...over,
});
const notify = (over: Partial<CapacityActionRequest> = {}): CapacityActionRequest => ({
  kind: "notifyWaitlist",
  reason: "capacity is back",
  region: "ap-southeast-1",
  productFamily: "linux_instance",
  waitlistReason: "capacity",
  count: "2",
  ...over,
});

describe("capacity actions in the order of R9", () => {
  it("setCapacityLimit: authorize, limit, execute, with whole numbers", async () => {
    const r = rig();
    expect(await r.act(limit())).toEqual({ ok: true, replayed: false });
    expect(r.steps).toEqual(["authorize", "limit", "execute"]);
    expect(r.calls[0]).toEqual([
      "setLimit",
      { poolAccountId: POOL, region: "ap-southeast-1", quotaCode: "instance_vcpu", limit: 40 },
      "AWS raised the quota",
    ]);
  });

  it("notifyWaitlist runs the engine with the verified admin, not a field of the form", async () => {
    const r = rig();
    expect(await r.act({ ...notify(), adminId: "x" } as never)).toEqual({
      ok: true,
      replayed: false,
      notified: 2,
    });
    expect(r.calls[0]).toEqual([
      "notify",
      {
        productFamily: "linux_instance",
        region: "ap-southeast-1",
        reason: "capacity",
        count: 2,
        why: "capacity is back",
      },
      ACTOR.adminId,
    ]);
  });

  it("refuses a caller without the role and does nothing else", async () => {
    const r = rig({ allow: false });
    expect(await r.act(limit())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("validates before the limiter: bad numbers, ids, codes, reasons", async () => {
    for (const bad of [
      limit({ limit: "-1" }),
      limit({ limit: "1.5" }),
      limit({ limit: "1e3" }),
      limit({ limit: "2000000" }),
      limit({ limit: "" }),
      limit({ poolAccountId: "nope" }),
      limit({ quotaCode: "free_money" }),
      limit({ region: "ap southeast" }),
      limit({ reason: " " }),
      limit({ reason: "x".repeat(501) }),
      limit({ kind: "addPoolAccount" as never }),
      notify({ count: "0" }),
      notify({ count: "101" }),
      notify({ waitlistReason: "other" }),
      notify({ productFamily: "Linux;drop" }),
    ]) {
      const r = rig();
      expect(await r.act(bad)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("is rate limited before it writes", async () => {
    const r = rig({ limit: false });
    expect(await r.act(limit())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("answers a replay as a replay (R7) and maps repository refusals to fixed codes", async () => {
    expect(await rig({ set: { ok: true, replayed: true, value: {} } }).act(limit())).toEqual({
      ok: true,
      replayed: true,
    });
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["not_found", "not_found"],
      ["conflict", "conflict"],
    ] as const) {
      expect(await rig({ set: { ok: false, error } }).act(limit())).toEqual({ ok: false, code });
    }
  });

  it("a notifier that cannot send fails closed with one fixed code", async () => {
    const r = rig();
    const act = makeCapacityAction({
      authorize: async () => ACTOR,
      limiter: async () => true,
      run: async (_a, fn) => fn({} as AdminRepos, {} as Tx),
      notifyWaitlist: async () => {
        throw new Error("template not registered: secret");
      },
      clock: { now: () => NOW },
    });
    const answer = await act(notify());
    expect(answer).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(r.steps).toEqual([]);
  });

  it("fails closed when the database fails", async () => {
    expect(await rig({ boom: true }).act(limit())).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("the recompute preview", () => {
  it("is the live count plus the pending reservations, and shows the correction", () => {
    expect(describeCorrection(9, 4, 2)).toEqual({
      used: 9,
      corrected: 6,
      delta: -3,
      live: 4,
      pending: 2,
    });
    expect(describeCorrection(1, 4, 0).delta).toBe(3);
  });

  it("parses the live count as a whole number only", () => {
    expect(parseLive("12")).toBe(12);
    expect(parseLive("0")).toBe(0);
    for (const bad of ["-1", "1.5", "abc", "", "1e2", undefined, 3.5]) {
      expect(parseLive(bad)).toBeNull();
    }
  });
});
