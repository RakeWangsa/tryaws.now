import type { AdminActor, AdminRepos } from "@tc/db";
import { describe, expect, it } from "vitest";
import { fakeAdminDirectory, unavailableAdminDirectory } from "./admin-directory.ts";
import { makeAdminsAction, type AdminsFlowDeps } from "./admins-flow.ts";

const ME = "0191a000-0000-7000-8000-0000000000a1";
const OTHER = "0191a000-0000-7000-8000-0000000000a2";
const SUB_OF_OTHER = "sub-other";
const actor: AdminActor = { adminId: ME, role: "superadmin", ip: "203.0.113.5" };

interface Harness {
  deps: AdminsFlowDeps;
  log: string[];
  repoCalls: unknown[][];
  directory: ReturnType<typeof fakeAdminDirectory>;
  roles: unknown[];
}

function harness(
  over: {
    limiter?: () => Promise<boolean>;
    authorize?: () => Promise<AdminActor>;
    answer?: { ok: true; replayed: boolean } | { ok: false; error: string };
    directory?: ReturnType<typeof fakeAdminDirectory>;
  } = {},
): Harness {
  const log: string[] = [];
  const repoCalls: unknown[][] = [];
  const roles: unknown[] = [];
  const directory = over.directory ?? fakeAdminDirectory();
  const answer = over.answer ?? { ok: true, replayed: false };
  const result = (value: unknown) => (answer.ok ? { ...answer, value } : answer);
  const repos = {
    adminUsers: {
      create: async (...a: unknown[]) => (
        repoCalls.push(["create", ...a]),
        result({ id: OTHER, role: "ops", status: "active" })
      ),
      setRole: async (...a: unknown[]) => (
        repoCalls.push(["setRole", ...a]),
        result({ id: OTHER, role: "ops", status: "active" })
      ),
      disable: async (...a: unknown[]) => (
        repoCalls.push(["disable", ...a]),
        result({ id: OTHER, role: "ops", status: "disabled" })
      ),
      enable: async (...a: unknown[]) => (
        repoCalls.push(["enable", ...a]),
        result({ id: OTHER, role: "ops", status: "active" })
      ),
      recordDirectoryAction: async (...a: unknown[]) => (
        repoCalls.push(["record", ...a]),
        result({ id: OTHER })
      ),
      detail: async () => ({
        ok: true,
        replayed: false,
        value: { id: OTHER, cognitoSub: SUB_OF_OTHER },
      }),
    },
  } as unknown as AdminRepos;
  const deps: AdminsFlowDeps = {
    authorize: async (r) => {
      roles.push(r);
      log.push("authorize");
      return (over.authorize ?? (async () => actor))();
    },
    limiter: async () => {
      log.push("limit");
      return (over.limiter ?? (async () => true))();
    },
    run: async (who, fn) => {
      log.push("run");
      expect(who).toEqual(actor);
      return fn(repos);
    },
    directory,
    clock: { now: () => new Date("2026-11-12T00:00:00Z") },
  };
  return { deps, log, repoCalls, directory, roles };
}

const base = { reason: "because" };

describe("makeAdminsAction", () => {
  it("asks for the superadmin role, then validates, rate limits and executes, in that order (R9)", async () => {
    const h = harness();
    const out = await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, ...base });
    expect(out).toMatchObject({ ok: true, replayed: false, targetId: OTHER, directory: "done" });
    expect(h.roles).toEqual([["superadmin"]]);
    expect(h.log).toEqual(["authorize", "limit", "run"]);
  });

  it("answers denied and does nothing when the session is not a superadmin", async () => {
    const h = harness({ authorize: async () => Promise.reject(new Error("no")) });
    expect(await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, ...base })).toEqual({
      ok: false,
      code: "denied",
    });
    expect(h.log).toEqual(["authorize"]);
  });

  it("takes the acting admin from the session only: forged actor or approver fields are ignored", async () => {
    const h = harness();
    await makeAdminsAction(h.deps)({
      kind: "setAdminRole",
      id: OTHER,
      role: "ops",
      ...base,
      // none of these is a field of the request; they must change nothing
      actorId: OTHER,
      adminId: OTHER,
      approvedBy: OTHER,
      requestedBy: OTHER,
    } as never);
    // `run` asserts the actor is the session admin; the repository gets only the target, role and reason
    expect(h.repoCalls).toEqual([["setRole", { adminId: OTHER, role: "ops" }, "because"]]);
  });

  it.each([
    { kind: "inviteAdmin", email: "not-an-email", role: "ops" },
    { kind: "inviteAdmin", email: "a@b.example", role: "root" },
    { kind: "inviteAdmin", email: "a@b.example" },
    { kind: "setAdminRole", id: "nope", role: "ops" },
    { kind: "setAdminRole", id: OTHER, role: "boss" },
    { kind: "disableAdmin", id: 5 },
    { kind: "resetAdminMfa", id: "x" },
    { kind: "bogus", id: OTHER },
  ])("refuses an invalid request without reaching the limiter or the database: %j", async (req) => {
    const h = harness();
    expect(await makeAdminsAction(h.deps)({ ...req, ...base } as never)).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(h.log).toEqual(["authorize"]);
  });

  it("refuses a blank or long reason", async () => {
    const h = harness();
    for (const reason of ["", "   ", "x".repeat(501), undefined, 4]) {
      expect(
        await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, reason } as never),
      ).toEqual({ ok: false, code: "invalid" });
    }
  });

  it("refuses to change the own role or to disable oneself with the code `self`", async () => {
    const h = harness();
    expect(
      await makeAdminsAction(h.deps)({ kind: "setAdminRole", id: ME, role: "ops", ...base }),
    ).toEqual({ ok: false, code: "self" });
    expect(await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: ME, ...base })).toEqual({
      ok: false,
      code: "self",
    });
    expect(h.repoCalls).toEqual([]);
  });

  it("rate limits before the database, and fails closed when the limiter fails", async () => {
    const limited = harness({ limiter: async () => false });
    expect(
      await makeAdminsAction(limited.deps)({ kind: "enableAdmin", id: OTHER, ...base }),
    ).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(limited.log).toEqual(["authorize", "limit"]);
    const broken = harness({ limiter: async () => Promise.reject(new Error("db")) });
    expect(
      await makeAdminsAction(broken.deps)({ kind: "enableAdmin", id: OTHER, ...base }),
    ).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("maps the repository refusals to fixed codes", async () => {
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["conflict", "conflict"],
      ["not_found", "not_found"],
    ] as const) {
      const h = harness({ answer: { ok: false, error } });
      expect(await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, ...base })).toEqual({
        ok: false,
        code,
      });
      // a refused change never reaches the directory
      expect(h.directory.calls).toEqual([]);
    }
  });

  it("invites through the directory first and stores only the returned sub, never the email", async () => {
    const h = harness();
    const out = await makeAdminsAction(h.deps)({
      kind: "inviteAdmin",
      email: "New.Admin@Example.com",
      role: "ops",
      ...base,
    });
    expect(out).toMatchObject({ ok: true, targetId: OTHER });
    expect(h.directory.calls[0]).toEqual(["invite", "new.admin@example.com"]);
    const [call] = h.repoCalls;
    expect(call?.[0]).toBe("create");
    expect(JSON.stringify(call)).not.toContain("example.com");
    expect((call?.[1] as { cognitoSub: string }).cognitoSub).toMatch(/^fake-sub-/);
  });

  it("an invitation that the directory cannot make writes nothing (R16)", async () => {
    const h = harness({ directory: unavailableAdminDirectory as never });
    const out = await makeAdminsAction(h.deps)({
      kind: "inviteAdmin",
      email: "a@b.example",
      role: "ops",
      ...base,
    });
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(h.repoCalls).toEqual([]);
  });

  it("disable and enable tell the directory after the change; a directory failure is reported, not hidden", async () => {
    const h = harness();
    await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, ...base });
    await makeAdminsAction(h.deps)({ kind: "enableAdmin", id: OTHER, ...base });
    expect(h.directory.calls).toEqual([
      ["setEnabled", SUB_OF_OTHER, false],
      ["setEnabled", SUB_OF_OTHER, true],
    ]);
    const failing = fakeAdminDirectory({ failing: true });
    const f = harness({ directory: failing });
    expect(
      await makeAdminsAction(f.deps)({ kind: "disableAdmin", id: OTHER, ...base }),
    ).toMatchObject({
      ok: true,
      directory: "failed",
    });
  });

  it("resetAdminMfa writes the audit row, then asks the directory; a directory failure is `unavailable`", async () => {
    const h = harness();
    expect(
      await makeAdminsAction(h.deps)({ kind: "resetAdminMfa", id: OTHER, ...base }),
    ).toMatchObject({
      ok: true,
      directory: "done",
    });
    expect(h.repoCalls).toEqual([["record", { adminId: OTHER, kind: "mfa_reset" }, "because"]]);
    expect(h.directory.calls).toEqual([["resetMfa", SUB_OF_OTHER]]);
    const f = harness({ directory: fakeAdminDirectory({ failing: true }) });
    expect(await makeAdminsAction(f.deps)({ kind: "resetAdminMfa", id: OTHER, ...base })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("passes a replay through", async () => {
    const h = harness({ answer: { ok: true, replayed: true } });
    expect(
      await makeAdminsAction(h.deps)({ kind: "disableAdmin", id: OTHER, ...base }),
    ).toMatchObject({
      ok: true,
      replayed: true,
    });
  });
});
