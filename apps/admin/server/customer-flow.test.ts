import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import { makeCustomerAction, type CustomerActionRequest } from "./customer-flow.ts";

const ID = "0191a000-0000-7000-8000-000000000001";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "ops",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");

// A recorder of the order of the steps and of the calls that reached the repository.
function rig(over: { allow?: boolean; limit?: boolean; repo?: unknown; boom?: boolean } = {}) {
  const steps: string[] = [];
  const calls: [string, unknown, string][] = [];
  const answer = over.repo ?? { ok: true, replayed: false, value: { customerId: ID } };
  const record = (name: string) => async (input: unknown, reason: string) => {
    steps.push("execute");
    calls.push([name, input, reason]);
    return answer;
  };
  const repos = {
    customers: {
      approveKyc: record("approveKyc"),
      rejectKyc: record("rejectKyc"),
      setRiskTier: record("setRiskTier"),
      suspend: record("suspend"),
      resume: record("resume"),
    },
  } as unknown as AdminRepos;
  const act = makeCustomerAction({
    authorize: async () => {
      steps.push("authorize");
      if (over.allow === false) throw new Error("no");
      return ACTOR;
    },
    limiter: async () => {
      steps.push("limit");
      return over.limit !== false;
    },
    run: async (_actor, fn) => {
      if (over.boom) throw new Error("database down: secret detail");
      return fn(repos);
    },
    clock: { now: () => NOW },
  });
  return { act, steps, calls };
}

const good = (over: Partial<CustomerActionRequest> = {}): CustomerActionRequest => ({
  kind: "approveKyc",
  id: ID,
  reason: "documents match",
  ...over,
});

describe("customer decisions in the order of R9", () => {
  it("authorizes, validates, limits, executes", async () => {
    const r = rig();
    expect(await r.act(good())).toEqual({ ok: true, replayed: false, customerId: ID });
    expect(r.steps).toEqual(["authorize", "limit", "execute"]);
    expect(r.calls).toEqual([["approveKyc", { submissionId: ID, at: NOW }, "documents match"]]);
  });

  it("passes the note of a rejection and the tier, and trims the reason", async () => {
    const r = rig();
    await r.act(good({ kind: "rejectKyc", note: " blurred ", reason: "  unreadable " }));
    await r.act(good({ kind: "setRiskTier", tier: "trusted" }));
    await r.act(good({ kind: "suspend" }));
    await r.act(good({ kind: "resume" }));
    expect(r.calls).toEqual([
      ["rejectKyc", { submissionId: ID, at: NOW, note: "blurred" }, "unreadable"],
      ["setRiskTier", { customerId: ID, tier: "trusted" }, "documents match"],
      ["suspend", { customerId: ID, at: NOW }, "documents match"],
      ["resume", { customerId: ID, at: NOW }, "documents match"],
    ]);
  });

  it("an admin without the role is refused before anything else (fail closed)", async () => {
    const r = rig({ allow: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it.each([
    ["an unknown kind", { kind: "delete" as never }],
    ["an id that is not a UUID", { id: "1 or 1=1" }],
    ["no id", { id: undefined }],
    ["a blank reason", { reason: "   " }],
    ["a reason that is not text", { reason: 5 }],
    ["a reason over 500 characters", { reason: "r".repeat(501) }],
    ["a note over 500 characters", { kind: "rejectKyc" as const, note: "n".repeat(501) }],
    ["a note that is not text", { kind: "rejectKyc" as const, note: { a: 1 } }],
    ["a tier that does not exist", { kind: "setRiskTier" as const, tier: "vip" }],
    ["no tier", { kind: "setRiskTier" as const }],
  ])("%s is invalid and never reaches the limiter or the database", async (_name, over) => {
    const r = rig();
    expect(await r.act(good(over as Partial<CustomerActionRequest>))).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("over the limit nothing is executed", async () => {
    const r = rig({ limit: false });
    expect(await r.act(good())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("repository refusals become fixed codes; forbidden is denied", async () => {
    for (const [error, code] of [
      ["not_found", "not_found"],
      ["conflict", "conflict"],
      ["forbidden", "denied"],
      ["validation", "invalid"],
    ] as const) {
      const r = rig({ repo: { ok: false, error } });
      expect(await r.act(good())).toEqual({ ok: false, code });
    }
  });

  it("a replay is reported as a success with replayed true (R7)", async () => {
    const r = rig({ repo: { ok: true, replayed: true, value: { customerId: ID } } });
    expect(await r.act(good())).toEqual({ ok: true, replayed: true, customerId: ID });
  });

  it("a failing database is unavailable and its text never reaches the answer (R14, R16)", async () => {
    const r = rig({ boom: true });
    const out = await r.act(good());
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });
});
