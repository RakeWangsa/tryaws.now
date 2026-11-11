import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  destroyFamilyCore,
  setRunningCore,
  type FamilyActionDeps,
  type FamilyRepos,
  type FamilySpec,
} from "./family-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const DB = "0190aaaa-0000-7000-8000-0000000000d1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const DB_SPEC: FamilySpec = {
  family: "database",
  idField: "databaseId",
  prefix: "database",
  withFinalSnapshot: true,
};
const LB_SPEC: FamilySpec = {
  family: "load_balancer",
  idField: "loadBalancerId",
  prefix: "lb",
  withFinalSnapshot: false,
};

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

const row = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: DB,
  family: "database",
  productId: PRODUCT,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "main-db" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    destroyError?: "conflict" | "not_found";
    requestError?: "not_found" | "conflict";
    session?: CustomerSession | null;
  } = {},
) {
  const calls: string[] = [];
  const rows = over.rows ?? [row()];
  const repos: FamilyRepos = {
    flagOn: async () => over.flag !== false,
    resources: {
      list: async () => rows,
      get: async (id) => rows.find((r) => r.id === id) ?? null,
      countLive: async () => 0,
      listChildren: async () => [],
      createBackupRow: async () => {
        throw new Error("not used");
      },
    },
    subscriptions: {
      requestDestroy: async (input: { idempotencyKey: string; withFinalSnapshot: boolean }) => {
        calls.push(`destroy:${input.idempotencyKey}:${input.withFinalSnapshot}`);
        if (over.destroyError) return { ok: false, error: over.destroyError };
        return {
          ok: true,
          replayed: false,
          value: { destroyOperationId: "d", finalSnapshotOperationId: null, needsApproval: true },
        } as never;
      },
    } as never,
    operations: {
      request: async (input: { kind: string; idempotencyKey: string; resourceId: string }) => {
        calls.push(`op:${input.kind}:${input.idempotencyKey}:${input.resourceId}`);
        if (over.requestError) return { ok: false, error: over.requestError };
        return { ok: true, replayed: false, value: { needsApproval: false } } as never;
      },
    } as never,
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return over.auditOk === false ? { ok: false, error: "validation" } : { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async () => {
        calls.push("rate");
        return { allowed: over.allowed !== false } as never;
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls };
}

describe("setRunningCore", () => {
  const stop = { databaseId: DB, requestId: REQ, run: "stop" };

  it("authenticates, rates, executes and audits in that order (R9); stop has its own key (R7)", async () => {
    const { deps, calls } = world();
    expect(await setRunningCore(deps, DB_SPEC, stop)).toEqual({ ok: true, done: "stopped" });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `op:stop:database-run:${REQ}:${DB}`,
      "audit:database.stop",
    ]);
  });

  it("start is allowed from stopped only, stop from active only", async () => {
    const stopped = world({ rows: [row({ state: "stopped" })] });
    expect(await setRunningCore(stopped.deps, DB_SPEC, { ...stop, run: "start" })).toEqual({
      ok: true,
      done: "started",
    });
    expect(stopped.calls).toContain(`op:start:database-run:${REQ}:${DB}`);
    expect(await setRunningCore(world().deps, DB_SPEC, { ...stop, run: "start" })).toEqual({
      ok: false,
      error: "not_allowed",
    });
    for (const state of ["suspended", "creating", "failed", "destroyed"] as const) {
      expect(await setRunningCore(world({ rows: [row({ state })] }).deps, DB_SPEC, stop)).toEqual({
        ok: false,
        error: "not_allowed",
      });
    }
  });

  it("refuses without a session before anything else, and bad input before the store opens", async () => {
    const none = world({ session: null });
    expect(await setRunningCore(none.deps, DB_SPEC, stop)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(none.calls).toEqual([]);
    const bad = world();
    expect(
      await setRunningCore(bad.deps, DB_SPEC, { databaseId: "x", requestId: "y", run: "maybe" }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { databaseId: "invalid", requestId: "invalid", run: "invalid" },
    });
    expect(bad.calls).toEqual([]);
  });

  it("a flag that is off writes nothing (R12); another customer's row, a missing one and another family are one answer (R8)", async () => {
    const off = world({ flag: false });
    expect(await setRunningCore(off.deps, DB_SPEC, stop)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(off.calls).not.toContain("rate");
    const missing = await setRunningCore(world({ rows: [] }).deps, DB_SPEC, stop);
    const other = await setRunningCore(
      world({ rows: [row({ family: "bucket" })] }).deps,
      DB_SPEC,
      stop,
    );
    expect(missing).toEqual({ ok: false, error: "not_found" });
    expect(other).toEqual(missing);
  });

  it("is rate limited; a refused audit or operation rolls back with a fixed key (R16)", async () => {
    expect(await setRunningCore(world({ allowed: false }).deps, DB_SPEC, stop)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await setRunningCore(world({ auditOk: false }).deps, DB_SPEC, stop)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await setRunningCore(world({ requestError: "conflict" }).deps, DB_SPEC, stop)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("destroyFamilyCore", () => {
  const input = { databaseId: DB, requestId: REQ, confirmName: "main-db" };

  it("needs a fresh sign-in (U10), then the exact name, then a destroy with a final snapshot for a database (R13)", async () => {
    const stale = world({ session: session(new Date(NOW.getTime() - 3 * 3_600_000)) });
    expect(await destroyFamilyCore(stale.deps, DB_SPEC, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);

    expect(
      await destroyFamilyCore(world().deps, DB_SPEC, { ...input, confirmName: "Main-db" }),
    ).toEqual({ ok: false, error: "name_mismatch" });

    const { deps, calls } = world();
    expect(await destroyFamilyCore(deps, DB_SPEC, input)).toEqual({
      ok: true,
      done: "destroyQueued",
      approval: true,
    });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `destroy:destroy:${REQ}:true`,
      "audit:database.destroy",
    ]);
  });

  it("a load balancer has no snapshot: its settings are kept (R13)", async () => {
    const lb = row({ family: "load_balancer", config: { displayName: "front" } });
    const { deps, calls } = world({ rows: [lb] });
    const result = await destroyFamilyCore(deps, LB_SPEC, {
      loadBalancerId: DB,
      requestId: REQ,
      confirmName: "front",
    });
    expect(result).toEqual({ ok: true, done: "destroyQueued", approval: true });
    expect(calls).toContain(`destroy:destroy:${REQ}:false`);
    expect(calls).toContain("audit:lb.destroy");
  });

  it("refuses a resource that is not live, not the customer's, an empty name, a flag that is off and a conflict", async () => {
    const answer = (w: ReturnType<typeof world>) => destroyFamilyCore(w.deps, DB_SPEC, input);
    expect(await answer(world({ rows: [row({ state: "creating" })] }))).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect(await answer(world({ rows: [] }))).toEqual({ ok: false, error: "not_found" });
    expect(await answer(world({ flag: false }))).toEqual({ ok: false, error: "flag_off" });
    expect(await answer(world({ destroyError: "conflict" }))).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect(await answer(world({ rows: [row({ config: {} })] }))).toEqual({
      ok: false,
      error: "name_mismatch",
    });
  });
});
