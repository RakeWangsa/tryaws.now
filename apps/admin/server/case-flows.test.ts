import type { AdminActor, AdminRepos, AdminRole } from "@tc/db";
import { describe, expect, it } from "vitest";
import { makeAbuseAction, type AbuseActionRequest } from "./abuse-flow.ts";
import { makeReconciliationAction } from "./reconciliation-flow.ts";
import { makeSupportAction, REPLY_REASON, type SupportActionRequest } from "./support-flow.ts";

const ID = "0191a000-0000-7000-8000-000000000001";
const ID2 = "0191a000-0000-7000-8000-000000000002";
const RES = "0191a000-0000-7000-8000-000000000003";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "support",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");
const OK = (value: unknown, replayed = false) => ({ ok: true, replayed, value });

interface Over {
  allow?: boolean;
  limit?: boolean;
  boom?: boolean;
  answer?: unknown;
  sendFails?: boolean;
  replyEnabled?: boolean;
}

function rig(over: Over = {}) {
  const steps: string[] = [];
  const calls: [string, unknown, string][] = [];
  const asked: (readonly AdminRole[])[] = [];
  const sent: unknown[] = [];
  const answer = over.answer ?? OK({});
  const record = (name: string) => async (input: unknown, reason: string) => {
    steps.push("execute");
    calls.push([name, input, reason]);
    return answer;
  };
  const repos = {
    support: {
      reply: record("reply"),
      close: record("closeRequest"),
      reopen: record("reopenRequest"),
    },
    abuse: {
      open: record("open"),
      addNote: record("addNote"),
      close: record("close"),
      suspendResource: record("suspend"),
      restoreResource: record("restore"),
    },
    payments: { resolveDiscrepancy: record("resolve") },
  } as unknown as AdminRepos;
  const common = {
    authorize: async (roles: readonly AdminRole[]) => {
      steps.push("authorize");
      asked.push(roles);
      if (over.allow === false) throw new Error("no");
      return ACTOR;
    },
    limiter: async () => {
      steps.push("limit");
      return over.limit !== false;
    },
    run: async <T>(_actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) => {
      if (over.boom) throw new Error("database down: secret detail");
      const out = await fn(repos);
      steps.push("committed");
      return out;
    },
    clock: { now: () => NOW },
  };
  const queue = {
    send: async (message: unknown) => {
      steps.push("send");
      if (over.sendFails) throw new Error("sqs down");
      sent.push(message);
    },
  };
  return {
    steps,
    calls,
    asked,
    sent,
    support: makeSupportAction({ ...common, replyEnabled: over.replyEnabled !== false }),
    abuse: makeAbuseAction({ ...common, queue }),
    reconciliation: makeReconciliationAction(common),
  };
}

describe("support actions in the order of R9", () => {
  const reply = (o: Partial<SupportActionRequest> = {}): SupportActionRequest => ({
    kind: "replyByEmail",
    id: ID,
    replyId: ID2,
    body: "  We refunded it.  ",
    ...o,
  });
  const close = (o: Partial<SupportActionRequest> = {}): SupportActionRequest => ({
    kind: "closeRequest",
    id: ID,
    reason: "solved by phone",
    ...o,
  });

  it("a reply authorizes, validates, limits, executes with a fixed reason and the trimmed text", async () => {
    const r = rig();
    expect(await r.support(reply())).toEqual({
      ok: true,
      replayed: false,
      targetId: ID,
      sent: true,
    });
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed"]);
    expect(r.asked).toEqual([["support", "superadmin"]]);
    expect(r.calls).toEqual([
      ["reply", { requestId: ID, replyId: ID2, body: "We refunded it." }, REPLY_REASON],
    ]);
  });

  it("a close passes the reason of the admin", async () => {
    const r = rig();
    expect(await r.support(close())).toMatchObject({ ok: true });
    expect(r.calls).toEqual([["closeRequest", { requestId: ID }, "solved by phone"]]);
  });

  // WPU-Z5: a closed request is opened again by an admin, with a reason (R10), in the order of R9.
  it("a reopen authorizes, validates, limits and passes the request and the reason of the admin", async () => {
    const r = rig();
    expect(
      await r.support({ kind: "reopenRequest", id: ID.toUpperCase(), reason: " customer wrote " }),
    ).toEqual({ ok: true, replayed: false, targetId: ID, sent: true });
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed"]);
    expect(r.asked).toEqual([["support", "superadmin"]]);
    expect(r.calls).toEqual([["reopenRequest", { requestId: ID }, "customer wrote"]]);
  });

  it("a reopen needs a reason and a request id; a refusal of the repository is a fixed code", async () => {
    for (const request of [
      { kind: "reopenRequest", id: ID, reason: "" },
      { kind: "reopenRequest", id: ID, reason: "x".repeat(501) },
      { kind: "reopenRequest", id: "x", reason: "r" },
    ] as SupportActionRequest[]) {
      const r = rig();
      expect(await r.support(request)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
    const missing = rig({ answer: { ok: false, error: "not_found" } });
    expect(await missing.support({ kind: "reopenRequest", id: ID, reason: "r" })).toEqual({
      ok: false,
      code: "not_found",
    });
    const replay = rig({ answer: OK({}, true) });
    expect(await replay.support({ kind: "reopenRequest", id: ID, reason: "r" })).toMatchObject({
      ok: true,
      replayed: true,
    });
  });

  it("a reopen is not a reply: it runs while the reply template is switched off", async () => {
    const r = rig({ replyEnabled: false });
    expect(await r.support({ kind: "reopenRequest", id: ID, reason: "r" })).toMatchObject({
      ok: true,
    });
  });

  it("the form cannot name the acting admin: an extra field changes nothing", async () => {
    const r = rig();
    await r.support({ ...close(), adminId: "x", handledBy: "x" } as never);
    expect(JSON.stringify(r.calls)).not.toContain('"x"');
  });

  it("refuses a caller without the role before anything else", async () => {
    const r = rig({ allow: false });
    expect(await r.support(close())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("validates before the limiter and the database", async () => {
    const bad = [
      close({ kind: "deleteRequest" as never }),
      close({ id: "x" }),
      close({ reason: "" }),
      close({ reason: "x".repeat(501) }),
      reply({ replyId: "x" }),
      reply({ body: "   " }),
      reply({ body: "x".repeat(5001) }),
      reply({ body: 5 }),
    ];
    for (const request of bad) {
      const r = rig();
      expect(await r.support(request)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("a reply is refused while the template is not registered, and nothing is written (R16)", async () => {
    const r = rig({ replyEnabled: false });
    expect(await r.support(reply())).toEqual({ ok: false, code: "unavailable" });
    expect(r.steps).toEqual(["authorize"]);
    expect(await r.support(close())).toMatchObject({ ok: true });
  });

  it("over the limit nothing runs; a repository refusal and a database error give fixed codes", async () => {
    const limited = rig({ limit: false });
    expect(await limited.support(close())).toEqual({ ok: false, code: "rate_limited" });
    expect(limited.steps).toEqual(["authorize", "limit"]);
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["not_found", "not_found"],
      ["conflict", "conflict"],
    ] as const) {
      const r = rig({ answer: { ok: false, error } });
      expect(await r.support(close())).toEqual({ ok: false, code });
    }
    const down = await rig({ boom: true }).support(close());
    expect(down).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(down)).not.toContain("secret");
  });

  it("a replay is reported as a replay", async () => {
    const r = rig({ answer: OK({}, true) });
    expect(await r.support(close())).toMatchObject({ ok: true, replayed: true });
  });
});

describe("abuse actions in the order of R9", () => {
  const base = (kind: AbuseActionRequest["kind"], o: Partial<AbuseActionRequest> = {}) =>
    ({ kind, id: ID, reason: "spam reported", ...o }) as AbuseActionRequest;
  const MESSAGE = { operationId: ID2, resourceId: RES, enqueueSeq: 1 };

  it("openAbuseCase takes the case id from the form and passes a clean input", async () => {
    const r = rig();
    const out = await r.abuse(
      base("openAbuseCase", { resourceId: RES, source: "monitoring", notes: "  alert  " }),
    );
    expect(out).toEqual({ ok: true, replayed: false, targetId: ID, sent: true });
    expect(r.asked).toEqual([["ops", "support", "superadmin"]]);
    expect(r.calls).toEqual([
      [
        "open",
        { caseId: ID, resourceId: RES, source: "monitoring", notes: "alert" },
        "spam reported",
      ],
    ]);
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed"]);
  });

  it("addNote and closeAbuseCase pass the case, the note id and the clock", async () => {
    const r = rig();
    await r.abuse(base("addNote", { noteId: ID2, note: " called " }));
    await r.abuse(base("closeAbuseCase"));
    expect(r.calls).toEqual([
      ["addNote", { caseId: ID, noteId: ID2, note: "called", at: NOW }, "spam reported"],
      ["close", { caseId: ID, at: NOW }, "spam reported"],
    ]);
  });

  it("suspendResource asks for ops and superadmin only, and sends the queue message after the commit", async () => {
    const r = rig({ answer: OK({ message: MESSAGE }) });
    expect(await r.abuse(base("suspendResource"))).toEqual({
      ok: true,
      replayed: false,
      targetId: ID,
      sent: true,
    });
    expect(r.asked).toEqual([["ops", "superadmin"]]);
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed", "send"]);
    expect(r.sent).toEqual([MESSAGE]);
  });

  it("restoreResource (WPU-B5) asks for ops and superadmin only, calls the restore and sends after the commit", async () => {
    const r = rig({ answer: OK({ message: MESSAGE }) });
    expect(await r.abuse(base("restoreResource"))).toEqual({
      ok: true,
      replayed: false,
      targetId: ID,
      sent: true,
    });
    expect(r.asked).toEqual([["ops", "superadmin"]]);
    expect(r.calls).toEqual([["restore", { caseId: ID, at: NOW }, "spam reported"]]);
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed", "send"]);
    expect(r.sent).toEqual([MESSAGE]);
  });

  it("a lost send is reported as not sent, never as a failure (the scheduler finds the row)", async () => {
    const r = rig({ answer: OK({ message: MESSAGE }), sendFails: true });
    expect(await r.abuse(base("suspendResource"))).toEqual({
      ok: true,
      replayed: false,
      targetId: ID,
      sent: false,
    });
  });

  it("a replayed suspension has no message and sends nothing", async () => {
    const r = rig({ answer: OK({ message: null }, true) });
    expect(await r.abuse(base("suspendResource"))).toMatchObject({
      ok: true,
      replayed: true,
      sent: true,
    });
    expect(r.sent).toEqual([]);
  });

  it("a role refused by the session gets no database work", async () => {
    const r = rig({ allow: false });
    expect(await r.abuse(base("suspendResource"))).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("validates every kind before the limiter", async () => {
    const bad: AbuseActionRequest[] = [
      base("deleteCase" as never),
      base("closeAbuseCase", { id: "x" }),
      base("closeAbuseCase", { reason: " " }),
      base("openAbuseCase", { resourceId: "x", source: "monitoring" }),
      base("openAbuseCase", { resourceId: RES, source: "gossip" }),
      base("openAbuseCase", { resourceId: RES, source: "monitoring", notes: "x".repeat(2001) }),
      base("addNote", { noteId: "x", note: "a" }),
      base("addNote", { noteId: ID2, note: " " }),
      base("addNote", { noteId: ID2, note: "x".repeat(1001) }),
    ];
    for (const request of bad) {
      const r = rig();
      expect(await r.abuse(request)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("maps repository refusals and a database error to fixed codes", async () => {
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["not_found", "not_found"],
      ["conflict", "conflict"],
    ] as const) {
      const r = rig({ answer: { ok: false, error } });
      expect(await r.abuse(base("closeAbuseCase"))).toEqual({ ok: false, code });
    }
    expect(await rig({ limit: false }).abuse(base("closeAbuseCase"))).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(await rig({ boom: true }).abuse(base("closeAbuseCase"))).toEqual({
      ok: false,
      code: "unavailable",
    });
  });
});

describe("resolveDiscrepancy in the order of R9", () => {
  const request = (o: object = {}) =>
    ({ kind: "resolveDiscrepancy", id: ID, reason: "invoice checked", ...o }) as never;

  it("authorizes ops, finance and superadmin, limits, executes through payments.resolveDiscrepancy", async () => {
    const r = rig();
    expect(await r.reconciliation(request())).toEqual({
      ok: true,
      replayed: false,
      targetId: ID,
      sent: true,
    });
    expect(r.asked).toEqual([["ops", "finance", "superadmin"]]);
    expect(r.calls).toEqual([["resolve", { id: ID }, "invoice checked"]]);
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed"]);
  });

  it("validates, refuses and maps errors without leaking text", async () => {
    for (const bad of [request({ kind: "x" }), request({ id: "x" }), request({ reason: "" })]) {
      const r = rig();
      expect(await r.reconciliation(bad)).toEqual({ ok: false, code: "invalid" });
      expect(r.steps).toEqual(["authorize"]);
    }
    expect(await rig({ allow: false }).reconciliation(request())).toEqual({
      ok: false,
      code: "denied",
    });
    expect(await rig({ limit: false }).reconciliation(request())).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(
      await rig({ answer: { ok: false, error: "not_found" } }).reconciliation(request()),
    ).toEqual({ ok: false, code: "not_found" });
    expect(await rig({ boom: true }).reconciliation(request())).toEqual({
      ok: false,
      code: "unavailable",
    });
  });
});
