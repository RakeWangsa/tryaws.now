import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import { createDbSnapshotCore, deleteDbSnapshotCore } from "./db-snapshot-actions.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-G9: manual snapshots of a database. Create is an operation on a new child row; delete is
// destructive (fresh sign-in, typed name, R13 guard, approval until 2026-12-01). Nothing is sold while
// the snapshot price is unavailable (R16).
const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const DB = "0190aaaa-0000-7000-8000-0000000000d1";
const SNAP = "0190aaaa-0000-7000-8000-0000000000e1";
const FOREIGN = "0190aaaa-0000-7000-8000-0000000000ff";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const session = (fresh = true): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - (fresh ? 60_000 : 3 * 3600_000)),
});
const row = (over: Partial<ResourceSummary> & { id: string; family: string }): ResourceSummary => ({
  productId: null,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "main" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    children?: ResourceSummary[];
    priceOn?: boolean;
    fresh?: boolean;
    allowed?: boolean;
    approval?: boolean;
  } = {},
) {
  const rows = over.rows ?? [
    row({ id: DB, family: "database" }),
    row({
      id: SNAP,
      family: "backup",
      parentResourceId: DB,
      config: { displayName: "before", manual: true },
    }),
  ];
  const calls: string[] = [];
  const requests: unknown[] = [];
  const created: unknown[] = [];
  const repos: FamilyRepos = {
    flagOn: async () => true,
    snapshotPriceOn: async () => over.priceOn !== false,
    resources: {
      get: async (id: string) => rows.find((r) => r.id === id) ?? null,
      listChildren: async () => over.children ?? [],
      createBackupRow: async (input: { id: string; parentId: string; displayName: string }) => {
        created.push(input);
        return { ok: true, value: row({ id: input.id, family: "backup", state: "creating" }) };
      },
    } as never,
    subscriptions: {} as never,
    operations: {
      request: async (input: unknown) => {
        calls.push("request");
        requests.push(input);
        return { ok: true, value: { needsApproval: over.approval === true } };
      },
    } as never,
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return { ok: true };
      },
    } as never,
    rateLimits: { consume: async () => ({ allowed: over.allowed !== false }) } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => session(over.fresh !== false),
    now: () => NOW,
    store: async (_c, fn) => fn(repos),
  };
  return { deps, calls, requests, created };
}

describe("createDbSnapshotCore", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    databaseId: DB,
    requestId: REQ,
    name: "before the migration",
    ...over,
  });
  it("writes the row of the snapshot and queues create_backup on it, then audits (R7, R9)", async () => {
    const w = world();
    expect(await createDbSnapshotCore(w.deps, form())).toEqual({
      ok: true,
      done: "snapshotCreated",
    });
    expect(w.created).toEqual([{ id: REQ, parentId: DB, displayName: "before the migration" }]);
    expect(w.requests).toEqual([
      { resourceId: REQ, kind: "create_backup", idempotencyKey: `db-snapshot-create:${REQ}` },
    ]);
    expect(w.calls).toEqual(["request", "audit:db.snapshot_create"]);
  });
  it("another customer's database is not found (R8) and a database not active is not allowed", async () => {
    expect(await createDbSnapshotCore(world().deps, form({ databaseId: FOREIGN }))).toEqual({
      ok: false,
      error: "not_found",
    });
    const w = world({ rows: [row({ id: DB, family: "database", state: "stopped" })] });
    expect(await createDbSnapshotCore(w.deps, form())).toEqual({ ok: false, error: "not_allowed" });
    expect(w.requests).toEqual([]);
  });
  it("a server is not a database", async () => {
    const w = world({ rows: [row({ id: DB, family: "linux_instance" })] });
    expect(await createDbSnapshotCore(w.deps, form())).toEqual({ ok: false, error: "not_found" });
  });
  it("sells nothing while the price is unavailable (R16)", async () => {
    const w = world({ priceOn: false });
    expect(await createDbSnapshotCore(w.deps, form())).toEqual({
      ok: false,
      error: "not_allowed",
      fields: { price: "unavailable" },
    });
    expect(w.created).toEqual([]);
    expect(w.requests).toEqual([]);
  });
  it("stops at ten manual snapshots, final ones not counted", async () => {
    const manual = Array.from({ length: 10 }, (_, i) =>
      row({
        id: `0190aaaa-0000-7000-8000-00000000a0${i}`,
        family: "backup",
        config: { displayName: "m" },
      }),
    );
    const w = world({ children: manual });
    expect(await createDbSnapshotCore(w.deps, form())).toEqual({ ok: false, error: "not_allowed" });
    const withFinal = world({
      children: [
        ...manual.slice(0, 9),
        row({
          id: "0190aaaa-0000-7000-8000-00000000a0f",
          family: "backup",
          config: { final: true },
        }),
      ],
    });
    expect((await createDbSnapshotCore(withFinal.deps, form())).ok).toBe(true);
  });
  it("validates the name and the ids before the store, refuses a used limit and no session (R9)", async () => {
    const w = world();
    for (const bad of [
      { name: "" },
      { name: "<b>" },
      { name: "x".repeat(61) },
      { databaseId: "x" },
    ]) {
      expect(await createDbSnapshotCore(w.deps, form(bad)), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(w.requests).toEqual([]);
    expect(await createDbSnapshotCore(world({ allowed: false }).deps, form())).toEqual({
      ok: false,
      error: "rate_limited",
    });
    const none = world();
    expect(
      await createDbSnapshotCore({ ...none.deps, authenticate: async () => null }, form()),
    ).toEqual({ ok: false, error: "unauthenticated" });
  });
});

describe("deleteDbSnapshotCore", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    backupId: SNAP,
    requestId: REQ,
    confirmName: "before",
    ...over,
  });
  it("needs a fresh sign-in first (U10)", async () => {
    const w = world({ fresh: false });
    expect(await deleteDbSnapshotCore(w.deps, form())).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(w.requests).toEqual([]);
  });
  it("needs the typed name; then queues delete_backup and reports the approval (R13)", async () => {
    expect(await deleteDbSnapshotCore(world().deps, form({ confirmName: "other" }))).toEqual({
      ok: false,
      error: "name_mismatch",
    });
    const w = world({ approval: true });
    expect(await deleteDbSnapshotCore(w.deps, form())).toEqual({
      ok: true,
      done: "snapshotDeleting",
      approval: true,
    });
    expect(w.requests).toEqual([
      { resourceId: SNAP, kind: "delete_backup", idempotencyKey: `db-snapshot-delete:${REQ}` },
    ]);
    expect(w.calls).toEqual(["request", "audit:db.snapshot_delete"]);
  });
  it("another customer's snapshot is not found (R8); a final snapshot or a snapshot of a server is not allowed", async () => {
    expect(await deleteDbSnapshotCore(world().deps, form({ backupId: FOREIGN }))).toEqual({
      ok: false,
      error: "not_found",
    });
    const final = world({
      rows: [
        row({ id: DB, family: "database" }),
        row({
          id: SNAP,
          family: "backup",
          parentResourceId: DB,
          config: { displayName: "before", final: true },
        }),
      ],
    });
    expect(await deleteDbSnapshotCore(final.deps, form())).toEqual({
      ok: false,
      error: "not_allowed",
    });
    const ofServer = world({
      rows: [
        row({ id: DB, family: "linux_instance" }),
        row({
          id: SNAP,
          family: "backup",
          parentResourceId: DB,
          config: { displayName: "before" },
        }),
      ],
    });
    expect(await deleteDbSnapshotCore(ofServer.deps, form())).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
