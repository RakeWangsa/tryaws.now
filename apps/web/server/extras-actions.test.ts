import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  MAX_MANUAL_BACKUPS,
  attachDiskCore,
  createBackupCore,
  deleteBackupCore,
  destroyDiskCore,
  destroyServerCore,
  detachDiskCore,
  markNotificationsReadCore,
  setAutoBackupCore,
  renewNowCore,
  setAutoRenewCore,
  type ExtrasDeps,
  type ExtrasRepos,
} from "./extras-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";
const DISK = "0190aaaa-0000-7000-8000-0000000000a2";
const BACKUP = "0190aaaa-0000-7000-8000-0000000000a3";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

const row = (over: Partial<ResourceSummary> & { config?: unknown }): ResourceSummary => ({
  id: SERVER,
  family: "linux_instance",
  productId: null,
  region: "ap-south-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "web-1" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

interface World {
  deps: ExtrasDeps;
  calls: string[];
  setSession(s: CustomerSession | null): void;
}

function world(
  over: {
    rows?: ResourceSummary[];
    children?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    approval?: boolean;
    destroyError?: "conflict" | "not_found";
    renew?: Awaited<ReturnType<ExtrasRepos["renewNow"]>>;
  } = {},
): World {
  const calls: string[] = [];
  const rows = over.rows ?? [
    row({}),
    row({ id: DISK, family: "disk", config: { displayName: "data", sizeGb: 20 } }),
    row({
      id: BACKUP,
      family: "backup",
      parentResourceId: SERVER,
      config: { displayName: "before-upgrade" },
    }),
  ];
  let current: CustomerSession | null = session();
  const repos: ExtrasRepos = {
    serversOn: async () => over.flag !== false,
    renewNow: async (id) => {
      calls.push(`renew:${id}`);
      return over.renew ?? { ok: true, value: { periodEnd: NOW } };
    },
    resources: {
      list: async () => rows,
      get: async (id) => rows.find((r) => r.id === id) ?? null,
      countLive: async () => 0,
      listChildren: async () => over.children ?? [],
      createBackupRow: async (input) => {
        calls.push(`backupRow:${input.displayName}`);
        return {
          ok: true,
          replayed: false,
          value: row({ id: input.id, family: "backup", parentResourceId: input.parentId }),
        };
      },
    },
    subscriptions: {
      get: async () => null,
      list: async () => [],
      setAutoRenew: async (id, on) => {
        calls.push(`autoRenew:${on}`);
        return id === SERVER
          ? { ok: true, replayed: false, value: {} as never }
          : { ok: false, error: "not_found" };
      },
      requestDestroy: async (input) => {
        calls.push(`destroy:${input.withFinalSnapshot}`);
        if (over.destroyError) return { ok: false, error: over.destroyError };
        return {
          ok: true,
          replayed: false,
          value: {
            destroyOperationId: "d",
            finalSnapshotOperationId: input.withFinalSnapshot ? "s" : null,
            needsApproval: over.approval !== false,
          },
        };
      },
    },
    operations: {
      get: async () => null,
      listForResource: async () => [],
      listRecent: async () => [],
      request: async (input) => {
        calls.push(`op:${input.kind}:${JSON.stringify(input.payload ?? null)}`);
        return {
          ok: true,
          replayed: false,
          value: {
            id: "o",
            resourceId: input.resourceId,
            kind: input.kind,
            state: "queued",
            step: null,
            needsApproval: over.approval === true,
            createdAt: NOW,
          },
        };
      },
    },
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}`);
        return over.auditOk === false
          ? { ok: false, error: "validation" }
          : { ok: true, replayed: false, value: { id: "a" } };
      },
    },
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.allowed === false
          ? { allowed: false, action: "x", retryAfterSeconds: 5 }
          : { allowed: true };
      },
    },
    notifications: {
      list: async () => [],
      unreadCount: async () => 0,
      markRead: async (ids) => {
        calls.push(`markRead:${ids === undefined ? "all" : ids.length}`);
        return 1;
      },
    },
  };
  const deps: ExtrasDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      expect(customerId).toBe(CUSTOMER);
      calls.push("store");
      return fn(repos);
    },
  };
  return { deps, calls, setSession: (s) => (current = s) };
}

describe("R9 order: authenticate, authorize, validate, rate limit, execute, audit", () => {
  it("createBackup", async () => {
    const w = world();
    const r = await createBackupCore(w.deps, { serverId: SERVER, requestId: REQ, name: "nightly" });
    expect(r).toEqual({ ok: true, done: "backupCreated" });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "rateLimit",
      "backupRow:nightly",
      "op:create_backup:null",
      "audit:backup.create",
    ]);
  });
  it("deleteBackup checks the fresh sign-in first and the name before the operation", async () => {
    const w = world();
    const r = await deleteBackupCore(w.deps, {
      backupId: BACKUP,
      requestId: REQ,
      confirmName: "before-upgrade",
    });
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "rateLimit",
      "op:delete_backup:null",
      "audit:backup.delete",
    ]);
  });
});

describe("U10: destructive actions", () => {
  const input = { serverId: SERVER, requestId: REQ, confirmName: "web-1" };
  it("a sign-in older than ten minutes is refused before the store is opened", async () => {
    const w = world();
    w.setSession(session(new Date(NOW.getTime() - 3_600_000)));
    for (const run of [destroyServerCore, destroyDiskCore, deleteBackupCore]) {
      expect(await run(w.deps, { ...input, diskId: DISK, backupId: BACKUP })).toEqual({
        ok: false,
        error: "fresh_sign_in_required",
      });
    }
    expect(w.calls.includes("store")).toBe(false);
  });
  it("a wrong typed name queues nothing and counts as name_mismatch", async () => {
    const w = world();
    expect(await destroyServerCore(w.deps, { ...input, confirmName: "web-2" })).toEqual({
      ok: false,
      error: "name_mismatch",
    });
    expect(await destroyServerCore(w.deps, { ...input, confirmName: "" })).toEqual({
      ok: false,
      error: "name_mismatch",
    });
    expect(w.calls.some((c) => c.startsWith("destroy:") || c.startsWith("audit"))).toBe(false);
  });
  it("the server destroy requests the final snapshot (R13) and reports the approval queue", async () => {
    const w = world({ approval: true });
    expect(await destroyServerCore(w.deps, input)).toEqual({
      ok: true,
      done: "destroyQueued",
      approval: true,
    });
    expect(w.calls).toContain("destroy:true");
    expect(w.calls.at(-1)).toBe("audit:server.destroy");
  });
  it("a server that is still being created, failed or gone is not destroyed", async () => {
    for (const state of ["creating", "failed", "destroyed"] as const) {
      const w = world({ rows: [row({ state })] });
      expect(await destroyServerCore(w.deps, input)).toEqual({ ok: false, error: "not_allowed" });
    }
  });
  it("a subscription that is not active or in grace is a refusal, not a second destroy", async () => {
    const w = world({ destroyError: "conflict" });
    expect(await destroyServerCore(w.deps, input)).toEqual({ ok: false, error: "not_allowed" });
    expect(w.calls.includes("audit:server.destroy")).toBe(false);
  });
  it("an attached disk cannot be destroyed; a detached one can", async () => {
    const attached = world({
      rows: [
        row({
          id: DISK,
          family: "disk",
          config: { displayName: "data", attachedInstanceId: SERVER },
        }),
      ],
    });
    expect(
      await destroyDiskCore(attached.deps, { diskId: DISK, requestId: REQ, confirmName: "data" }),
    ).toEqual({
      ok: false,
      error: "not_allowed",
    });
    const free = world();
    expect(
      await destroyDiskCore(free.deps, { diskId: DISK, requestId: REQ, confirmName: "data" }),
    ).toMatchObject({
      ok: true,
    });
    expect(free.calls).toContain("destroy:true");
  });
  it("the final backup belongs to the lifecycle: the customer cannot delete it", async () => {
    const w = world({
      rows: [row({ id: BACKUP, family: "backup", config: { displayName: "x", final: true } })],
    });
    expect(
      await deleteBackupCore(w.deps, { backupId: BACKUP, requestId: REQ, confirmName: "x" }),
    ).toEqual({ ok: false, error: "not_allowed" });
  });
});

describe("R8: another customer's row answers like a missing one", () => {
  it("every action on an unknown id is not_found and writes nothing", async () => {
    const w = world({ rows: [] });
    const results = await Promise.all([
      createBackupCore(w.deps, { serverId: SERVER, requestId: REQ, name: "n" }),
      deleteBackupCore(w.deps, { backupId: BACKUP, requestId: REQ, confirmName: "x" }),
      setAutoBackupCore(w.deps, { serverId: SERVER, requestId: REQ, enabled: "off" }),
      attachDiskCore(w.deps, {
        diskId: DISK,
        serverId: SERVER,
        requestId: REQ,
        diskPath: "/dev/xvdf",
      }),
      detachDiskCore(w.deps, { diskId: DISK, requestId: REQ }),
      destroyDiskCore(w.deps, { diskId: DISK, requestId: REQ, confirmName: "x" }),
      destroyServerCore(w.deps, { serverId: SERVER, requestId: REQ, confirmName: "x" }),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "not_found" });
    expect(
      w.calls.some((c) => c.startsWith("op:") || c.startsWith("audit") || c.startsWith("destroy")),
    ).toBe(false);
  });
});

describe("R8 sweep (WP9-T2): the two switches without an operation answer like the rest", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  it("setAutoRenew on an unknown id is not_found, and nothing is written or audited", async () => {
    const w = world({ rows: [] });
    expect(await setAutoRenewCore(w.deps, { serverId: SERVER, autoRenew: "on" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(w.calls.some((c) => c.startsWith("autoRenew") || c.startsWith("audit"))).toBe(false);
  });
  it("a customerId in the form is ignored: the store is opened for the session's customer only", async () => {
    // world().deps.store asserts customerId === CUSTOMER on every call.
    const w = world({ rows: [] });
    const results = await Promise.all([
      setAutoRenewCore(w.deps, { serverId: SERVER, autoRenew: "on", customerId: OTHER }),
      destroyServerCore(w.deps, {
        serverId: SERVER,
        requestId: REQ,
        confirmName: "x",
        customerId: OTHER,
      }),
      markNotificationsReadCore(w.deps, { id: BACKUP, customerId: OTHER }),
    ]);
    expect(results[0]).toEqual({ ok: false, error: "not_found" });
    expect(results[1]).toEqual({ ok: false, error: "not_found" });
    // The notification id goes to the tenant-scoped repository alone (it matches the customer's own rows).
    expect(results[2]).toEqual({ ok: true, done: "marked" });
    expect(w.calls).toContain("markRead:1");
  });
});

describe("gates", () => {
  const good = { serverId: SERVER, requestId: REQ, name: "nightly" };
  it("no session", async () => {
    const w = world();
    w.setSession(null);
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual(["authenticate"]);
  });
  it("flag off fails closed (R12, R16)", async () => {
    const w = world({ flag: false });
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "flag_off" });
  });
  it("rate limited", async () => {
    const w = world({ allowed: false });
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "rate_limited" });
    expect(w.calls.some((c) => c.startsWith("op:"))).toBe(false);
  });
  it("validation names the fields and touches nothing", async () => {
    const w = world();
    expect(await createBackupCore(w.deps, { serverId: "x", requestId: REQ, name: "<b>" })).toEqual({
      ok: false,
      error: "validation",
      fields: { serverId: "invalid", name: "invalid" },
    });
    expect(w.calls).toEqual(["authenticate"]);
    expect(
      await setAutoBackupCore(world().deps, {
        serverId: SERVER,
        requestId: REQ,
        enabled: "on",
        hour: "25:00",
      }),
    ).toMatchObject({
      ok: false,
      fields: { hour: "invalid" },
    });
  });
  it("a failed audit rolls the action back", async () => {
    const w = world({ auditOk: false });
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "unavailable" });
  });
  it("at most ten manual backups of one server", async () => {
    const children = Array.from({ length: MAX_MANUAL_BACKUPS }, (_, i) =>
      row({ id: `0190aaaa-0000-7000-8000-00000000010${i}`.slice(0, 36), family: "backup" }),
    );
    const w = world({ children });
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "limit_reached" });
  });
  it("a stopped-for-good (creating) server takes no backup", async () => {
    const w = world({ rows: [row({ state: "creating" })] });
    expect(await createBackupCore(w.deps, good)).toEqual({ ok: false, error: "not_allowed" });
  });
});

describe("storage and billing", () => {
  it("attach: same Region, free disk, a path of the offered list only", async () => {
    const w = world();
    const ok = await attachDiskCore(w.deps, {
      diskId: DISK,
      serverId: SERVER,
      requestId: REQ,
      diskPath: "/dev/xvdf",
    });
    expect(ok).toEqual({ ok: true, done: "diskAttaching" });
    expect(w.calls).toContain(`op:attach_disk:{"instanceId":"${SERVER}","diskPath":"/dev/xvdf"}`);
    const bad = await attachDiskCore(w.deps, {
      diskId: DISK,
      serverId: SERVER,
      requestId: REQ,
      diskPath: "/etc/passwd",
    });
    expect(bad).toMatchObject({ ok: false, error: "validation" });
    const other = world({
      rows: [
        row({}),
        row({ id: DISK, family: "disk", region: "ap-southeast-1", config: { displayName: "d" } }),
      ],
    });
    expect(
      await attachDiskCore(other.deps, {
        diskId: DISK,
        serverId: SERVER,
        requestId: REQ,
        diskPath: "/dev/xvdg",
      }),
    ).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });
  it("detach needs an attached disk", async () => {
    expect(await detachDiskCore(world().deps, { diskId: DISK, requestId: REQ })).toEqual({
      ok: false,
      error: "not_allowed",
    });
    const attached = world({
      rows: [
        row({ id: DISK, family: "disk", config: { displayName: "d", attachedInstanceId: SERVER } }),
      ],
    });
    expect(await detachDiskCore(attached.deps, { diskId: DISK, requestId: REQ })).toMatchObject({
      ok: true,
    });
  });
  it("auto backup carries the hour only when on", async () => {
    const on = world();
    await setAutoBackupCore(on.deps, {
      serverId: SERVER,
      requestId: REQ,
      enabled: "on",
      hour: "03:00",
    });
    expect(on.calls).toContain('op:set_auto_backup:{"enabled":true,"hour":"03:00"}');
    const off = world();
    await setAutoBackupCore(off.deps, { serverId: SERVER, requestId: REQ });
    expect(off.calls).toContain('op:set_auto_backup:{"enabled":false}');
  });
  it("auto renew is a switch with an audit entry", async () => {
    const w = world();
    expect(await setAutoRenewCore(w.deps, { serverId: SERVER, autoRenew: "on" })).toEqual({
      ok: true,
      done: "autoRenewOn",
    });
    expect(w.calls.at(-1)).toBe("audit:subscription.auto_renew_on");
  });
});

describe("renewNow (16.10 Billing)", () => {
  const input = { serverId: SERVER };
  it("follows R9: authenticate, rate limit, execute, audit", async () => {
    const w = world();
    expect(await renewNowCore(w.deps, input)).toEqual({ ok: true, done: "renewed" });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "rateLimit",
      `renew:${SERVER}`,
      "audit:subscription.renew_now",
    ]);
  });
  it("another customer's server, or none, is not_found and nothing is charged or audited (R8)", async () => {
    const w = world({ rows: [] });
    expect(await renewNowCore(w.deps, input)).toEqual({ ok: false, error: "not_found" });
    expect(w.calls.some((c) => c.startsWith("renew:") || c.startsWith("audit"))).toBe(false);
  });
  it("a disk id is not a server: not_found", async () => {
    const w = world();
    expect(await renewNowCore(w.deps, { serverId: DISK })).toEqual({
      ok: false,
      error: "not_found",
    });
  });
  it("a bad id is a validation error before anything is opened", async () => {
    const w = world();
    expect(await renewNowCore(w.deps, { serverId: "x" })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(w.calls).toEqual(["authenticate"]);
  });
  it("no session, flag off and a full rate limit are refused", async () => {
    const none = world();
    none.setSession(null);
    expect(await renewNowCore(none.deps, input)).toEqual({ ok: false, error: "unauthenticated" });
    expect(await renewNowCore(world({ flag: false }).deps, input)).toEqual({
      ok: false,
      error: "flag_off",
    });
    const limited = world({ allowed: false });
    expect(await renewNowCore(limited.deps, input)).toEqual({ ok: false, error: "rate_limited" });
    expect(limited.calls.some((c) => c.startsWith("renew:"))).toBe(false);
  });
  it("maps the refusals of the renewal to fixed keys", async () => {
    const short = world({
      renew: { ok: false, error: "insufficient_balance", data: { shortfallMinor: "5" } },
    });
    expect(await renewNowCore(short.deps, input)).toEqual({
      ok: false,
      error: "insufficient_balance",
    });
    const early = world({ renew: { ok: false, error: "conflict" } });
    expect(await renewNowCore(early.deps, input)).toEqual({ ok: false, error: "not_due" });
    const odd = world({ renew: { ok: false, error: "internal" } });
    expect(await renewNowCore(odd.deps, input)).toEqual({ ok: false, error: "unavailable" });
    expect(short.calls.some((c) => c.startsWith("audit"))).toBe(false);
  });
  it("without the audit entry everything rolls back", async () => {
    const w = world({ auditOk: false });
    expect(await renewNowCore(w.deps, input)).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("markNotificationsRead", () => {
  it("marks all, or one, after authenticate and the rate limit, and audits", async () => {
    const w = world();
    expect(await markNotificationsReadCore(w.deps, {})).toEqual({ ok: true, done: "marked" });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "rateLimit",
      "markRead:all",
      "audit:notification.mark_read",
    ]);
    const one = world();
    await markNotificationsReadCore(one.deps, { id: BACKUP });
    expect(one.calls).toContain("markRead:1");
  });
  it("refuses a bad id and a missing session", async () => {
    expect(await markNotificationsReadCore(world().deps, { id: "nope" })).toMatchObject({
      ok: false,
      error: "validation",
    });
    const w = world();
    w.setSession(null);
    expect(await markNotificationsReadCore(w.deps, {})).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });
});
