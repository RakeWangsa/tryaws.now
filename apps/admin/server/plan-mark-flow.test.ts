import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import { makePlanMarkAction, type PlanMarkRequest } from "./plan-mark-flow.ts";

// WPA-P2. clearPlanChangeMark in the order of R9: authenticate and authorize (ops, superadmin), validate,
// rate limit, execute (one transaction, audited in the repository), and send after the commit. The
// request has no field for an actor or a role.
const RES = "0191a000-0000-7000-8000-000000000002";
const REQ = "0191a000-0000-7000-8000-000000000003";
const OP = "0191a000-0000-7000-8000-000000000004";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "ops",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");
const MESSAGE = { operationId: OP, resourceId: RES, enqueueSeq: 1 };

function rig(
  over: {
    allow?: boolean;
    limit?: boolean;
    write?: unknown;
    boom?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const calls: [unknown, string][] = [];
  const sent: unknown[] = [];
  const answer = over.write ?? {
    ok: true,
    replayed: false,
    value: { resourceId: RES, operationId: OP, message: MESSAGE },
  };
  const repos = {
    operations: {
      clearPlanChangeMark: async (input: unknown, reason: string) => {
        steps.push("execute");
        calls.push([input, reason]);
        return answer;
      },
    },
  } as unknown as AdminRepos;
  const act = makePlanMarkAction({
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
    run: async (_actor, fn) => {
      if (over.boom) throw new Error("database down: secret detail");
      const out = await fn(repos);
      steps.push("committed");
      return out;
    },
    queue: {
      send: async (message) => {
        steps.push("send");
        if (over.sendFails) throw new Error("sqs down");
        sent.push(message);
      },
    },
    clock: { now: () => NOW },
  });
  return { act, steps, calls, sent };
}

const good = (over: Partial<PlanMarkRequest> = {}): PlanMarkRequest => ({
  resourceId: RES,
  requestId: REQ,
  reason: "customer fixed the cause",
  ...over,
});

describe("clearPlanChangeMark in the order of R9", () => {
  it("authorizes, limits, executes, commits and only then sends", async () => {
    const r = rig();
    expect(await r.act(good())).toEqual({ ok: true, replayed: false, targetId: RES, sent: true });
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed", "send"]);
    expect(r.calls).toEqual([
      [{ resourceId: RES, requestId: REQ, at: NOW }, "customer fixed the cause"],
    ]);
    expect(r.sent).toEqual([MESSAGE]);
  });

  it("does nothing for a caller without the role and tells nothing", async () => {
    const r = rig({ allow: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("validates before the limiter and the database", async () => {
    for (const bad of [
      good({ resourceId: "nope" }),
      good({ resourceId: 5 }),
      good({ requestId: "nope" }),
      good({ requestId: undefined }),
      good({ reason: "" }),
      good({ reason: "   " }),
      good({ reason: "x".repeat(501) }),
      good({ reason: undefined }),
    ]) {
      const r = rig();
      expect(await r.act(bad)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("is rate limited before it writes", async () => {
    const r = rig({ limit: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("has no field for an actor, a role or an operation: the repository gets the three ids and the time only", async () => {
    const r = rig();
    await r.act({ ...good(), adminId: "x", role: "superadmin", operationId: OP } as never);
    expect(r.calls[0]?.[0]).toEqual({ resourceId: RES, requestId: REQ, at: NOW });
  });

  it("a replay sends nothing and says so", async () => {
    const r = rig({
      write: {
        ok: true,
        replayed: true,
        value: { resourceId: RES, operationId: OP, message: null },
      },
    });
    expect(await r.act(good())).toEqual({ ok: true, replayed: true, targetId: RES, sent: true });
    expect(r.sent).toEqual([]);
  });

  it.each([
    [{ ok: false, error: "forbidden" }, "denied"],
    [{ ok: false, error: "validation" }, "invalid"],
    [{ ok: false, error: "not_found" }, "not_found"],
    [{ ok: false, error: "conflict" }, "conflict"],
  ])("maps the refusal %j to %s", async (write, code) => {
    const r = rig({ write });
    expect(await r.act(good())).toEqual({ ok: false, code });
    expect(r.sent).toEqual([]);
  });

  it("a lost send is not an error: the scheduler finds the queued operation", async () => {
    const r = rig({ sendFails: true });
    expect(await r.act(good())).toEqual({ ok: true, replayed: false, targetId: RES, sent: false });
  });

  it("fails closed on a database error without telling the cause (R14, R16)", async () => {
    const r = rig({ boom: true });
    expect(await r.act(good())).toEqual({ ok: false, code: "unavailable" });
  });
});
