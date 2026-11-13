import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  RENEWAL_CONFIRM_ROLES,
  makeConfirmUnrenewedAction,
  type ConfirmUnrenewedRequest,
} from "./renewal-flow.ts";

// WPU-X3 (b): the admin action "registry confirmed not renewed" in the order of R9. It writes an operation row through
// the repository (audited: actor, reason, IP, target, R10) and sends the queue message after the commit; it never
// calls AWS (R1). Finance and superadmin only.
const TARGET = "0191a000-0000-7000-8000-000000000001";
const FORM = "0191a000-0000-7000-8000-000000000003";
const CONFIRM = "0191a000-0000-7000-8000-000000000004";
const RES = "0191a000-0000-7000-8000-000000000002";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "finance",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-14T08:00:00.000Z");
const MESSAGE = { operationId: CONFIRM, resourceId: RES, enqueueSeq: 0 };

function rig(
  over: {
    role?: AdminActor["role"];
    limit?: boolean;
    write?: unknown;
    boom?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const calls: [unknown, string][] = [];
  const sent: unknown[] = [];
  const answer = over.write ?? { ok: true, replayed: false, value: { message: MESSAGE } };
  const repos = {
    operations: {
      confirmUnrenewed: async (input: unknown, reason: string) => {
        steps.push("execute");
        calls.push([input, reason]);
        return answer;
      },
    },
  } as unknown as AdminRepos;
  const act = makeConfirmUnrenewedAction({
    authorize: async (roles) => {
      steps.push("authorize");
      // The session check refuses a role that is not in the list (requireAdmin of packages/auth).
      const role = over.role ?? "finance";
      if (!roles.includes(role)) throw new Error("no");
      return { ...ACTOR, role };
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

const good = (over: Partial<ConfirmUnrenewedRequest> = {}): ConfirmUnrenewedRequest => ({
  id: TARGET,
  requestId: FORM,
  reason: "registrar support case 123: not renewed",
  ...over,
});

describe("registry confirmed not renewed, in the order of R9", () => {
  it("is for finance and superadmin only", () => {
    expect([...RENEWAL_CONFIRM_ROLES].sort()).toEqual(["finance", "superadmin"]);
  });

  it("authorizes, limits, executes, commits and only then sends", async () => {
    const r = rig();
    expect(await r.act(good())).toEqual({
      ok: true,
      replayed: false,
      targetId: TARGET,
      sent: true,
    });
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed", "send"]);
    expect(r.calls).toEqual([
      [
        { operationId: TARGET, requestId: FORM, at: NOW },
        "registrar support case 123: not renewed",
      ],
    ]);
    expect(r.sent).toEqual([MESSAGE]);
  });

  it("a superadmin may do it too", async () => {
    expect(await rig({ role: "superadmin" }).act(good())).toMatchObject({ ok: true });
  });

  it.each(["ops", "support"] as const)(
    "refuses %s before anything else and tells nothing",
    async (role) => {
      const r = rig({ role });
      expect(await r.act(good())).toEqual({ ok: false, code: "denied" });
      expect(r.steps).toEqual(["authorize"]);
      expect(r.calls).toEqual([]);
    },
  );

  it("validates before the limiter and the database", async () => {
    for (const bad of [
      good({ id: "not-a-uuid" }),
      good({ id: 5 }),
      good({ requestId: "x" }),
      good({ requestId: undefined }),
      good({ reason: "" }),
      good({ reason: "   " }),
      good({ reason: "x".repeat(501) }),
    ]) {
      const r = rig();
      expect(await r.act(bad)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("a rate-limited admin writes nothing", async () => {
    const r = rig({ limit: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("maps the refusals of the repository to fixed codes and sends nothing", async () => {
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["not_found", "not_found"],
      ["conflict", "conflict"],
    ] as const) {
      const r = rig({ write: { ok: false, error } });
      expect(await r.act(good())).toEqual({ ok: false, code });
      expect(r.sent).toEqual([]);
    }
  });

  it("a replay answers replayed and still sends the message of the first operation", async () => {
    const r = rig({ write: { ok: true, replayed: true, value: { message: MESSAGE } } });
    expect(await r.act(good())).toEqual({
      ok: true,
      replayed: true,
      targetId: TARGET,
      sent: true,
    });
  });

  it("a database error is unavailable and tells nothing (R14, R16)", async () => {
    const r = rig({ boom: true });
    const out = await r.act(good());
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("a lost send is not an error: the scheduler sends it again", async () => {
    const r = rig({ sendFails: true });
    expect(await r.act(good())).toMatchObject({ ok: true, sent: false });
  });
});
