import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  CDN_REMOVE_CERTIFICATE,
  CDN_REPLACE_CERTIFICATE,
  CONTAINER_REMOVE_CERTIFICATE,
  CONTAINER_REPLACE_CERTIFICATE,
  DB_PARAMETERS,
  DB_READ_PARAMETERS,
  DB_REBOOT,
  LB_REMOVE_CERTIFICATE,
  LB_REPLACE_CERTIFICATE,
  consoleCore,
} from "./console-actions.ts";
import type { ConsoleSpec } from "./console-actions.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-G11: remove and replace a certificate (fresh sign-in and the typed domain), the parameters of a
// database, and its reboot. The proofs of the table in console-actions.test.ts: R7 key, R8 answer, R9
// order, R16 refusals.
const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const OTHER = "0190aaaa-0000-7000-8000-0000000000f9";
const LB = "0190aaaa-0000-7000-8000-0000000000a1";
const CONTAINER = "0190aaaa-0000-7000-8000-0000000000a2";
const CDN = "0190aaaa-0000-7000-8000-0000000000a3";
const DB = "0190aaaa-0000-7000-8000-0000000000d1";

const session = (ageMs = 60_000): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - ageMs),
});

const certificate = { domain: "shop.example.com", status: "ISSUED", attached: true, records: [] };
const row = (
  id: string,
  family: string,
  config: Record<string, unknown> = {},
  state = "active",
): ResourceSummary => ({
  id,
  family,
  productId: null,
  region: "ap-southeast-1",
  state: state as ResourceSummary["state"],
  parentResourceId: null,
  config: { displayName: "mine", ...config },
  createdAt: NOW,
  deletedAt: null,
});

function world(
  rows: ResourceSummary[],
  over: { flag?: boolean; age?: number; allowed?: boolean } = {},
) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const repos: FamilyRepos = {
    flagOn: async () => {
      calls.push("flag");
      return over.flag ?? true;
    },
    resources: { get: async (id: string) => rows.find((r) => r.id === id) ?? null } as never,
    subscriptions: {} as never,
    operations: {
      request: async (input: unknown) => {
        calls.push("request");
        requests.push(input);
        return { ok: true, value: {} };
      },
    } as never,
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async () => {
        calls.push("limit");
        return { allowed: over.allowed ?? true };
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => session(over.age),
    now: () => NOW,
    store: async (_c, fn) => fn(repos),
  };
  return { deps, calls, requests };
}

describe.each([
  [
    "load balancer",
    LB_REMOVE_CERTIFICATE,
    LB_REPLACE_CERTIFICATE,
    "load_balancer",
    LB,
    "loadBalancerId",
    "lb",
  ],
  [
    "container service",
    CONTAINER_REMOVE_CERTIFICATE,
    CONTAINER_REPLACE_CERTIFICATE,
    "container_service",
    CONTAINER,
    "containerId",
    "container",
  ],
  ["CDN distribution", CDN_REMOVE_CERTIFICATE, CDN_REPLACE_CERTIFICATE, "cdn", CDN, "cdnId", "cdn"],
] as [string, ConsoleSpec, ConsoleSpec, string, string, string, string][])(
  "certificate of a %s",
  (_name, removeSpec, replaceSpec, family, id, idField, prefix) => {
    const remove = consoleCore(removeSpec);
    const replace = consoleCore(replaceSpec);
    const mine = (over: Record<string, unknown> = {}) => [
      row(id, family, { certificate, ...over }),
    ];
    const removeForm = (over: Record<string, unknown> = {}) => ({
      [idField]: id,
      requestId: REQ,
      confirmName: "shop.example.com",
      ...over,
    });
    const replaceForm = (over: Record<string, unknown> = {}) =>
      removeForm({ domain: "New.Example.com", ...over });

    it("remove: queues the kind with the request id as key after the typed domain matches (R7, R9)", async () => {
      const w = world(mine());
      expect(await remove(w.deps, removeForm({ confirmName: " Shop.Example.com " }))).toEqual({
        ok: true,
        done: "certificateRemoveQueued",
      });
      expect(w.requests).toEqual([
        {
          resourceId: id,
          kind: "remove_certificate",
          idempotencyKey: `${prefix}-cert-remove:${REQ}`,
          payload: {},
        },
      ]);
      // authorize (flag), rate limit, execute, audit.
      expect(w.calls).toEqual(["flag", "limit", "request", `audit:${prefix}.remove_certificate`]);
    });

    it("remove: needs a fresh sign-in before anything else, and the typed domain (U10)", async () => {
      const stale = world(mine(), { age: 3 * 3600_000 });
      expect(await remove(stale.deps, removeForm())).toEqual({
        ok: false,
        error: "fresh_sign_in_required",
      });
      expect(stale.calls).toEqual([]);
      for (const typed of [
        undefined,
        "",
        "other.example.com",
        "shop.example.co",
        "shop.example.com x",
      ]) {
        const w = world(mine());
        expect(await remove(w.deps, removeForm({ confirmName: typed })), String(typed)).toEqual({
          ok: false,
          error: "name_mismatch",
        });
        expect(w.requests).toEqual([]);
      }
    });

    it("remove: nothing to take away without a saved certificate, or when the resource is not active", async () => {
      const none = world([row(id, family)]);
      expect(await remove(none.deps, removeForm())).toEqual({ ok: false, error: "not_allowed" });
      const busy = world([row(id, family, { certificate }, "creating")]);
      expect(await remove(busy.deps, removeForm())).toEqual({ ok: false, error: "not_allowed" });
      expect(none.requests).toEqual([]);
      expect(busy.requests).toEqual([]);
    });

    it("another customer's resource, a missing one and a wrong family give one answer and queue nothing (R8)", async () => {
      const foreign = world([]);
      const a = await remove(foreign.deps, removeForm());
      const wrongFamily = world([row(id, "bucket", { certificate })]);
      const b = await remove(wrongFamily.deps, removeForm());
      const c = await replace(world([]).deps, replaceForm({ [idField]: OTHER }));
      expect(a).toEqual({ ok: false, error: "not_found" });
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(foreign.requests).toEqual([]);
      expect(wrongFamily.requests).toEqual([]);
    });

    it("the flag, the rate limit and the session are checked in order (R9, R12)", async () => {
      const off = world(mine(), { flag: false });
      expect(await remove(off.deps, removeForm())).toEqual({ ok: false, error: "flag_off" });
      const limited = world(mine(), { allowed: false });
      expect(await remove(limited.deps, removeForm())).toEqual({
        ok: false,
        error: "rate_limited",
      });
      const deps: FamilyActionDeps = { ...off.deps, authenticate: async () => null };
      expect(await remove(deps, removeForm())).toEqual({ ok: false, error: "unauthenticated" });
      expect(off.requests).toEqual([]);
      expect(limited.requests).toEqual([]);
    });

    it("replace: queues the checked new domain, lower case, after the old domain was typed (R11)", async () => {
      const w = world(mine());
      expect(await replace(w.deps, replaceForm())).toEqual({
        ok: true,
        done: "certificateReplaceQueued",
      });
      expect(w.requests).toEqual([
        {
          resourceId: id,
          kind: "replace_certificate",
          idempotencyKey: `${prefix}-cert-replace:${REQ}`,
          payload: { domain: "new.example.com" },
        },
      ]);
      expect(w.calls).toEqual(["flag", "limit", "request", `audit:${prefix}.replace_certificate`]);
    });

    it("replace: refuses a bad domain before the store, the same domain again, a stale sign-in and a wrong typed domain", async () => {
      for (const domain of ["*.example.com", "localhost", "a b.com", "x.com/path", "", undefined]) {
        const w = world(mine());
        expect(await replace(w.deps, replaceForm({ domain })), String(domain)).toMatchObject({
          ok: false,
          error: "validation",
          fields: { domain: "invalid" },
        });
        expect(w.calls).toEqual([]);
      }
      const same = world(mine());
      expect(await replace(same.deps, replaceForm({ domain: "SHOP.example.com" }))).toMatchObject({
        ok: false,
        error: "validation",
        fields: { domain: "invalid" },
      });
      const stale = world(mine(), { age: 3 * 3600_000 });
      expect(await replace(stale.deps, replaceForm())).toEqual({
        ok: false,
        error: "fresh_sign_in_required",
      });
      const wrong = world(mine());
      expect(await replace(wrong.deps, replaceForm({ confirmName: "nope.example.com" }))).toEqual({
        ok: false,
        error: "name_mismatch",
      });
      expect(same.requests).toEqual([]);
      expect(stale.requests).toEqual([]);
      expect(wrong.requests).toEqual([]);
    });
  },
);

describe("database parameters", () => {
  const items = [
    { name: "max_connections", value: "150", apply: "immediate", changeable: true },
    { name: "wait_timeout", value: "28800", apply: "immediate", changeable: false },
    { name: "slow_query_log", value: "0", apply: "immediate", changeable: true },
  ];
  const saved = (over: Record<string, unknown> = {}) => ({
    parameters: {
      engine: "mysql",
      rebootPending: false,
      readAt: NOW.toISOString(),
      items,
      ...over,
    },
  });
  const run = consoleCore(DB_PARAMETERS);
  const form = (over: Record<string, unknown> = {}) => ({
    databaseId: DB,
    requestId: REQ,
    ...over,
  });

  it("queues only the parameters that changed, as checked text (R7, R11)", async () => {
    const w = world([row(DB, "database", saved())]);
    expect(
      await run(
        w.deps,
        form({ max_connections: "300", slow_query_log: "0", wait_timeout: "", innodb_x: "1" }),
      ),
    ).toEqual({ ok: true, done: "parametersQueued" });
    expect(w.requests).toEqual([
      {
        resourceId: DB,
        kind: "set_db_parameters",
        idempotencyKey: `db-parameters:${REQ}`,
        payload: { parameters: { max_connections: "300" } },
      },
    ]);
    expect(w.calls).toEqual(["flag", "limit", "request", "audit:db.set_parameters"]);
  });

  it("refuses a value outside the rule, a parameter that is not changeable, no change at all and a name that is not on the list", async () => {
    for (const [input, fields] of [
      [{ max_connections: "0" }, { max_connections: "invalid" }],
      [{ max_connections: "1; DROP TABLE x" }, { max_connections: "invalid" }],
      [{ slow_query_log: "yes" }, { slow_query_log: "invalid" }],
      [{ wait_timeout: "600" }, { wait_timeout: "invalid" }],
      [{ max_connections: "150" }, { parameters: "invalid" }],
      [{}, { parameters: "invalid" }],
      [{ statement_timeout: "5" }, { parameters: "invalid" }],
      [{ skip_grant_tables: "ON" }, { parameters: "invalid" }],
    ] as [Record<string, unknown>, Record<string, string>][]) {
      const w = world([row(DB, "database", saved())]);
      expect(await run(w.deps, form(input)), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: "validation",
        fields,
      });
      expect(w.requests).toEqual([]);
    }
  });

  it("needs the list to be read first (no saved engine), an active database and the customer's own (R8, R16)", async () => {
    const unread = world([row(DB, "database")]);
    expect(await run(unread.deps, form({ max_connections: "300" }))).toEqual({
      ok: false,
      error: "not_allowed",
    });
    const stopped = world([row(DB, "database", saved(), "stopped")]);
    expect(await run(stopped.deps, form({ max_connections: "300" }))).toEqual({
      ok: false,
      error: "not_allowed",
    });
    const foreign = world([]);
    expect(await run(foreign.deps, form({ max_connections: "300" }))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(unread.requests).toEqual([]);
    expect(stopped.requests).toEqual([]);
  });

  it("read: queues the read of the list; reboot: needs the warning ticked", async () => {
    const read = world([row(DB, "database")]);
    expect(await consoleCore(DB_READ_PARAMETERS)(read.deps, form())).toEqual({
      ok: true,
      done: "parametersReadQueued",
    });
    expect(read.requests).toEqual([
      {
        resourceId: DB,
        kind: "read_db_parameters",
        idempotencyKey: `db-parameters-read:${REQ}`,
        payload: {},
      },
    ]);
    const reboot = consoleCore(DB_REBOOT);
    const no = world([row(DB, "database")]);
    expect(await reboot(no.deps, form())).toMatchObject({
      ok: false,
      error: "validation",
      fields: { acknowledge: "invalid" },
    });
    expect(no.calls).toEqual([]);
    const yes = world([row(DB, "database")]);
    expect(await reboot(yes.deps, form({ acknowledge: "yes" }))).toEqual({
      ok: true,
      done: "rebootQueued",
    });
    expect(yes.requests).toEqual([
      { resourceId: DB, kind: "reboot", idempotencyKey: `db-reboot:${REQ}`, payload: {} },
    ]);
    const wrong = world([row(LB, "load_balancer")]);
    expect(await reboot(wrong.deps, form({ databaseId: LB, acknowledge: "yes" }))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("read and reboot answer a foreign or missing database like not found and queue nothing (R8)", async () => {
    for (const spec of [DB_READ_PARAMETERS, DB_REBOOT, DB_PARAMETERS]) {
      const foreign = world([]);
      const input = { databaseId: OTHER, requestId: REQ, acknowledge: "yes", max_connections: "9" };
      expect(await consoleCore(spec)(foreign.deps, input), spec.kind).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(foreign.requests).toEqual([]);
    }
  });
});
