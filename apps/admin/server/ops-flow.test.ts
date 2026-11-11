import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import { makeOpsAction, type OpsActionRequest } from "./ops-flow.ts";

const ID = "0191a000-0000-7000-8000-000000000001";
const RES = "0191a000-0000-7000-8000-000000000002";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "ops",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");
const MESSAGE = { operationId: ID, resourceId: RES, enqueueSeq: 1 };

interface Row {
  state: string;
  kind: string;
  approvedBy: string | null;
}

function rig(
  over: {
    allow?: boolean;
    limit?: boolean;
    row?: Row | "missing";
    write?: unknown;
    boom?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const calls: [string, unknown, string][] = [];
  const sent: unknown[] = [];
  const row = over.row ?? { state: "needs_approval", kind: "destroy", approvedBy: null };
  const answer = over.write ?? { ok: true, replayed: false, value: { message: MESSAGE } };
  const record = (name: string) => async (input: unknown, reason: string) => {
    steps.push("execute");
    calls.push([name, input, reason]);
    return answer;
  };
  const repos = {
    operations: {
      detail: async () => {
        steps.push("read");
        return row === "missing" ? { ok: false, error: "not_found" } : { ok: true, value: row };
      },
      approve: record("approve"),
      reject: record("reject"),
      retry: record("retry"),
    },
  } as unknown as AdminRepos;
  const act = makeOpsAction({
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

const good = (over: Partial<OpsActionRequest> = {}): OpsActionRequest => ({
  kind: "approveOperation",
  id: ID,
  reason: "customer confirmed by phone",
  ...over,
});

describe("operation decisions in the order of R9", () => {
  it("authorizes, limits, reads, executes, commits and only then sends", async () => {
    const r = rig();
    expect(await r.act(good())).toEqual({ ok: true, replayed: false, targetId: ID, sent: true });
    expect(r.steps).toEqual(["authorize", "limit", "read", "execute", "committed", "send"]);
    expect(r.calls).toEqual([
      ["approve", { operationId: ID, at: NOW }, "customer confirmed by phone"],
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
      good({ kind: "cancelOperation" as never }),
      good({ id: "not-a-uuid" }),
      good({ id: 5 }),
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

  it("is rate limited before it reads or writes", async () => {
    const r = rig({ limit: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("has no field for an approver: the repository gets the operation id and the time, nothing else", async () => {
    const r = rig();
    const sneaky = { ...good(), approvedBy: "0191a000-0000-7000-8000-00000000ffff", adminId: "x" };
    await r.act(sneaky);
    expect(r.calls[0]?.[1]).toEqual({ operationId: ID, at: NOW });
  });

  it("reads each field once", async () => {
    const r = rig();
    let reads = 0;
    const request = {
      kind: "approveOperation",
      get id() {
        reads += 1;
        return ID;
      },
      reason: "ok",
    } as unknown as OpsActionRequest;
    await r.act(request);
    expect(reads).toBe(1);
  });

  it("routes each kind to its repository method", async () => {
    const stuck = { state: "needs_attention", kind: "reboot", approvedBy: null };
    const a = rig({ row: stuck });
    await a.act(good({ kind: "retryOperation" }));
    expect(a.calls[0]?.[0]).toBe("retry");
    const b = rig();
    await b.act(good({ kind: "rejectOperation" }));
    expect(b.calls[0]?.[0]).toBe("reject");
  });

  it("refuses a move that ADMIN_TRANSITIONS does not have, without calling the repository", async () => {
    for (const [kind, state] of [
      ["approveOperation", "queued"],
      ["approveOperation", "running"],
      ["retryOperation", "needs_approval"],
      ["retryOperation", "failed"],
      ["rejectOperation", "queued"],
      ["rejectOperation", "running"],
    ] as const) {
      const r = rig({ row: { state, kind: "reboot", approvedBy: null } });
      expect(await r.act(good({ kind }))).toEqual({ ok: false, code: "conflict" });
      expect(r.calls).toEqual([]);
      expect(r.sent).toEqual([]);
    }
  });

  it("refuses to reject a paid create", async () => {
    const r = rig({ row: { state: "needs_approval", kind: "create", approvedBy: null } });
    expect(await r.act(good({ kind: "rejectOperation" }))).toEqual({
      ok: false,
      code: "conflict",
    });
    expect(r.calls).toEqual([]);
  });

  it("answers a replay as a replay (R7) and sends nothing when the repository has no message", async () => {
    const r = rig({
      row: { state: "queued", kind: "destroy", approvedBy: ACTOR.adminId },
      write: { ok: true, replayed: true, value: { message: null } },
    });
    expect(await r.act(good())).toEqual({ ok: true, replayed: true, targetId: ID, sent: true });
    expect(r.sent).toEqual([]);
  });

  it("maps a missing operation and the refusals of the repository to fixed codes", async () => {
    expect(await rig({ row: "missing" }).act(good())).toEqual({ ok: false, code: "not_found" });
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["conflict", "conflict"],
      ["not_found", "not_found"],
    ] as const) {
      const r = rig({ write: { ok: false, error } });
      expect(await r.act(good())).toEqual({ ok: false, code });
      expect(r.sent).toEqual([]);
    }
  });

  it("is not an error when the queue is down: the scheduler sends it again", async () => {
    const r = rig({ sendFails: true });
    expect(await r.act(good())).toEqual({ ok: true, replayed: false, targetId: ID, sent: false });
  });

  it("fails closed with one fixed code when the database fails", async () => {
    const r = rig({ boom: true });
    const answer = await r.act(good());
    expect(answer).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(r.sent).toEqual([]);
  });
});
