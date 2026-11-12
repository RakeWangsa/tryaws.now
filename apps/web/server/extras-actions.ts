import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { SNAPSHOT_FAMILIES, decideDestructive } from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  NotificationsRepo,
  OperationsRepo,
  RateLimitsRepo,
  ResourceSummary,
  ResourcesRepo,
  SubscriptionsRepo,
} from "@tc/db";

// The cores of the Server Actions of the server tabs Backups, Storage, Billing and Destroy and of the
// bell. R9 order in each: authenticate, authorize (a fresh sign-in for a destructive action, U10; the
// flag and the ownership of the resource), validate, rate limit, execute, audit. Every action is an
// operation row or a switch (R1: nothing here calls AWS) and is idempotent by the request id that the
// page put in the form (R7). The ports are parameters, so the cores run in a test without a database.
// What leaves a core is a fixed public key, never the text of an error (U6, R14).

export interface ExtrasRepos {
  resources: ResourcesRepo;
  subscriptions: SubscriptionsRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  notifications: NotificationsRepo;
  /** R12, R16: the flag of the server family for the customer's market; false when it cannot be read. */
  serversOn(): Promise<boolean>;
  /** `renewNow` of @tc/core in this transaction (wallet, ledger, period); the customer comes from the scope. */
  renewNow(resourceId: string): Promise<RenewAnswer>;
}

/** What the renewal answers, as far as the action needs it. Nothing else leaves the port. */
export type RenewAnswer =
  { ok: true; value: { periodEnd: Date } } | { ok: false; error: string; data?: unknown };

export interface ExtrasDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: ExtrasRepos) => Promise<T>): Promise<T>;
}

export type ExtrasError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "flag_off"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "name_mismatch"
  | "not_allowed"
  | "limit_reached"
  | "insufficient_balance"
  | "not_due"
  | "unavailable";

export type ExtrasResult =
  | { ok: true; done: string; approval?: boolean }
  | { ok: false; error: ExtrasError; fields?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL = /^[A-Za-z0-9 ._-]{1,60}$/;
const HOUR = /^([01]\d|2[0-3]):00$/;
const DISK_PATH = /^\/dev\/xvd[f-p]$/;

/** At most this many manual backups of one server or disk (an assumption, JOURNEY.md). */
export const MAX_MANUAL_BACKUPS = 10;

const limit = (action: string, count: number, windowSeconds: number): CustomerLimit[] => [
  Object.freeze({ action, limit: count, windowSeconds }),
];
const WRITE_LIMIT = limit("server.extras", 30, 3600);
const DESTROY_LIMIT = limit("server.destroy", 5, 3600);
const READ_LIMIT = limit("notification.read", 60, 3600);
const RENEW_LIMIT = limit("subscription.renew", 10, 3600);

const SERVER_FAMILY = "linux_instance";
const LIVE_STATES = ["active", "stopped", "suspended"];

class Refusal extends Error {
  constructor(
    readonly error: ExtrasError,
    readonly fields?: Record<string, string>,
  ) {
    super(error);
  }
}

const fail = (error: ExtrasError, fields?: Record<string, string>): ExtrasResult => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}
function uuid(input: Record<string, unknown>, key: string, bad: Record<string, string>): string {
  const v = input[key];
  if (typeof v === "string" && UUID.test(v)) return v;
  bad[key] = "invalid";
  return "";
}

/** The fields of a resource config that the tabs read, one by one (nothing else leaves it). */
export function resourceFacts(row: ResourceSummary): {
  name: string;
  attachedTo: string | null;
  final: boolean;
  sizeGb: number | null;
} {
  const c = record(row.config);
  const attached = c["attachedInstanceId"];
  const size = c["sizeGb"];
  return {
    name: typeof c["displayName"] === "string" ? c["displayName"].slice(0, 60) : "",
    attachedTo: typeof attached === "string" && UUID.test(attached) ? attached : null,
    final: c["final"] === true,
    sizeGb: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null,
  };
}

interface Spec {
  /** A destructive action: the fresh sign-in is checked before anything else (U10). */
  destructive: boolean;
  limits: readonly CustomerLimit[];
}

// The common frame: authenticate, authorize, rate limit inside the transaction, then the body (which
// validates the input it reads from the store and executes), then the audit. A refusal thrown by the
// body rolls everything back, the counted rate limit included (the next try is a fresh count).
async function frame(
  deps: ExtrasDeps,
  spec: Spec,
  parse: () => { ok: true } | { ok: false; fields: Record<string, string> },
  body: (repos: ExtrasRepos, session: CustomerSession) => Promise<ExtrasResult>,
): Promise<ExtrasResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  if (spec.destructive && !requireFreshSignIn(session, { now: deps.now }).ok) {
    return fail("fresh_sign_in_required");
  }
  const parsed = parse();
  if (!parsed.ok) return fail("validation", parsed.fields);
  try {
    return await deps.store(session.customerId, async (repos) => {
      if (!(await repos.serversOn())) throw new Refusal("flag_off");
      const decision = await repos.rateLimits.consume(spec.limits, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      return body(repos, session);
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error, error.fields) : fail("unavailable");
  }
}

async function audit(
  repos: ExtrasRepos,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  const written = await repos.audit.record({ action, targetType, targetId });
  // The audit entry is part of the action: without it everything rolls back (R9, R16).
  if (!written.ok) throw new Error("extras: the audit entry was refused");
}

async function ownServer(repos: ExtrasRepos, id: string): Promise<ResourceSummary> {
  const row = await repos.resources.get(id);
  if (row === null || row.family !== SERVER_FAMILY) throw new Refusal("not_found");
  return row;
}

async function request(
  repos: ExtrasRepos,
  input: Parameters<OperationsRepo["request"]>[0],
): Promise<{ needsApproval: boolean }> {
  const written = await repos.operations.request(input);
  if (!written.ok) {
    throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
  }
  return { needsApproval: written.value.needsApproval };
}

// ----- Backups ---------------------------------------------------------------------------------

/** 16.10 Backups: `createBackup`. The row of the backup is written here, the adapter fills it in. */
export async function createBackupCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  const requestId = uuid(input, "requestId", bad);
  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (!LABEL.test(name)) bad["name"] = "invalid";
  return frame(
    deps,
    { destructive: false, limits: WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const server = await ownServer(repos, serverId);
      if (!LIVE_STATES.includes(server.state)) throw new Refusal("not_allowed");
      const existing = await repos.resources.listChildren(serverId, "backup");
      const manual = existing.filter((b) => !resourceFacts(b).final).length;
      if (manual >= MAX_MANUAL_BACKUPS) throw new Refusal("limit_reached");
      const row = await repos.resources.createBackupRow({
        id: requestId,
        parentId: serverId,
        displayName: name,
      });
      if (!row.ok) throw new Refusal(row.error === "validation" ? "validation" : "not_found");
      await request(repos, {
        resourceId: row.value.id,
        kind: "create_backup",
        idempotencyKey: `backup-create:${requestId}`,
      });
      await audit(repos, "backup.create", "resource", row.value.id);
      return { ok: true, done: "backupCreated" };
    },
  );
}

/** 16.10 Backups: `deleteBackup`. Destructive: fresh sign-in, the typed name and the guard (R13). */
export async function deleteBackupCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const backupId = uuid(input, "backupId", bad);
  const requestId = uuid(input, "requestId", bad);
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: DESTROY_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const backup = await repos.resources.get(backupId);
      if (backup === null || backup.family !== "backup") throw new Refusal("not_found");
      const facts = resourceFacts(backup);
      // The final backup belongs to the lifecycle (it is kept for the restore window).
      if (backup.state !== "active" || facts.final) throw new Refusal("not_allowed");
      if (
        !decideDestructive("delete_backup", {
          subscriptionStatus: null,
          family: backup.family,
          hasFinalSnapshot: false,
          isFinalBackup: facts.final,
        })
      ) {
        throw new Refusal("not_allowed");
      }
      if (facts.name === "" || typed !== facts.name) throw new Refusal("name_mismatch");
      const queued = await request(repos, {
        resourceId: backupId,
        kind: "delete_backup",
        idempotencyKey: `backup-delete:${requestId}`,
      });
      await audit(repos, "backup.delete", "resource", backupId);
      return { ok: true, done: "backupDeleting", approval: queued.needsApproval };
    },
  );
}

/** 16.10 Backups: `setAutoBackup`. Linux servers only (Lightsail has no add-on for Windows). */
export async function setAutoBackupCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  const requestId = uuid(input, "requestId", bad);
  const enabled = input["enabled"] === "on" || input["enabled"] === "true";
  const hour = typeof input["hour"] === "string" ? input["hour"] : "";
  if (enabled && !HOUR.test(hour)) bad["hour"] = "invalid";
  return frame(
    deps,
    { destructive: false, limits: WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const server = await ownServer(repos, serverId);
      if (!LIVE_STATES.includes(server.state)) throw new Refusal("not_allowed");
      await request(repos, {
        resourceId: serverId,
        kind: "set_auto_backup",
        idempotencyKey: `auto-backup:${requestId}`,
        payload: enabled ? { enabled: true, hour } : { enabled: false },
      });
      await audit(repos, "backup.auto", "resource", serverId);
      return { ok: true, done: "autoBackupSet" };
    },
  );
}

// ----- Storage ---------------------------------------------------------------------------------

async function ownDisk(repos: ExtrasRepos, id: string): Promise<ResourceSummary> {
  const row = await repos.resources.get(id);
  if (row === null || row.family !== "disk") throw new Refusal("not_found");
  return row;
}

/** 16.10 Storage: `attachDisk`. The disk and the server are the customer's, in one Region. */
export async function attachDiskCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const diskId = uuid(input, "diskId", bad);
  const serverId = uuid(input, "serverId", bad);
  const requestId = uuid(input, "requestId", bad);
  const diskPath = typeof input["diskPath"] === "string" ? input["diskPath"] : "";
  if (!DISK_PATH.test(diskPath)) bad["diskPath"] = "invalid";
  return frame(
    deps,
    { destructive: false, limits: WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const disk = await ownDisk(repos, diskId);
      const server = await ownServer(repos, serverId);
      if (disk.state !== "active" || resourceFacts(disk).attachedTo !== null) {
        throw new Refusal("not_allowed");
      }
      if (!["active", "stopped"].includes(server.state) || server.region !== disk.region) {
        throw new Refusal("not_allowed");
      }
      await request(repos, {
        resourceId: diskId,
        kind: "attach_disk",
        idempotencyKey: `disk-attach:${requestId}`,
        payload: { instanceId: serverId, diskPath },
      });
      await audit(repos, "disk.attach", "resource", diskId);
      return { ok: true, done: "diskAttaching" };
    },
  );
}

/** 16.10 Storage: `detachDisk`. */
export async function detachDiskCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const diskId = uuid(input, "diskId", bad);
  const requestId = uuid(input, "requestId", bad);
  return frame(
    deps,
    { destructive: false, limits: WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const disk = await ownDisk(repos, diskId);
      if (disk.state !== "active" || resourceFacts(disk).attachedTo === null) {
        throw new Refusal("not_allowed");
      }
      await request(repos, {
        resourceId: diskId,
        kind: "detach_disk",
        idempotencyKey: `disk-detach:${requestId}`,
      });
      await audit(repos, "disk.detach", "resource", diskId);
      return { ok: true, done: "diskDetaching" };
    },
  );
}

// The customer's own destroy of a resource with a subscription (server or disk): the subscription
// becomes `retained`, the final snapshot is queued where the family has one, then the destroy, which
// waits for an admin until the end date of R13 (the repository decides) and which the guard checks
// again when it is claimed.
async function destroyFlow(
  repos: ExtrasRepos,
  row: ResourceSummary,
  typed: string,
  requestId: string,
  action: string,
): Promise<ExtrasResult> {
  const facts = resourceFacts(row);
  if (!LIVE_STATES.includes(row.state)) throw new Refusal("not_allowed");
  if (facts.attachedTo !== null) throw new Refusal("not_allowed");
  if (facts.name === "" || typed !== facts.name) throw new Refusal("name_mismatch");
  const withFinalSnapshot = SNAPSHOT_FAMILIES.includes(row.family);
  // R13: after the subscription is `retained` and the snapshot exists, the guard must let it pass.
  if (
    !decideDestructive("destroy", {
      subscriptionStatus: "retained",
      family: row.family,
      hasFinalSnapshot: withFinalSnapshot,
      isFinalBackup: false,
    })
  ) {
    throw new Refusal("not_allowed");
  }
  const queued = await repos.subscriptions.requestDestroy({
    resourceId: row.id,
    idempotencyKey: `destroy:${requestId}`,
    withFinalSnapshot,
  });
  if (!queued.ok) {
    throw new Refusal(
      queued.error === "not_found"
        ? "not_found"
        : queued.error === "conflict"
          ? "not_allowed"
          : "unavailable",
    );
  }
  await audit(repos, action, "resource", row.id);
  return { ok: true, done: "destroyQueued", approval: queued.value.needsApproval };
}

/** 16.10 Storage: `destroyDisk`. A detached disk is still billed until it is destroyed. */
export async function destroyDiskCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const diskId = uuid(input, "diskId", bad);
  const requestId = uuid(input, "requestId", bad);
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: DESTROY_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) =>
      destroyFlow(repos, await ownDisk(repos, diskId), typed, requestId, "disk.destroy"),
  );
}

// ----- Billing and Destroy ---------------------------------------------------------------------

/** 16.10 Billing: `setAutoRenew`. Off means no charge without consent. */
export async function setAutoRenewCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  const on = input["autoRenew"] === "on" || input["autoRenew"] === "true";
  return frame(
    deps,
    { destructive: false, limits: WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      await ownServer(repos, serverId);
      const set = await repos.subscriptions.setAutoRenew(serverId, on);
      if (!set.ok) throw new Refusal("not_found");
      await audit(
        repos,
        on ? "subscription.auto_renew_on" : "subscription.auto_renew_off",
        "resource",
        serverId,
      );
      return { ok: true, done: on ? "autoRenewOn" : "autoRenewOff" };
    },
  );
}

/**
 * 16.10 Billing: `renewNow`. Charges the next period from the wallet at today's rate. The money is
 * moved by the one function of the lifecycle (idempotent by the ledger key of the period, R7); a
 * repeat click is refused as `not_due`. Money is never typed in by the client (R4).
 */
export async function renewNowCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  return frame(
    deps,
    { destructive: false, limits: RENEW_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      await ownServer(repos, serverId);
      const renewed = await repos.renewNow(serverId);
      if (!renewed.ok) {
        throw new Refusal(
          renewed.error === "not_found"
            ? "not_found"
            : renewed.error === "conflict"
              ? "not_due"
              : renewed.error === "insufficient_balance"
                ? "insufficient_balance"
                : "unavailable",
        );
      }
      await audit(repos, "subscription.renew_now", "resource", serverId);
      return { ok: true, done: "renewed" };
    },
  );
}

/** 16.10 Destroy: `destroyServer` (U10, R13; enters the approval queue until 2026-12-01). */
export async function destroyServerCore(deps: ExtrasDeps, raw: unknown): Promise<ExtrasResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  const requestId = uuid(input, "requestId", bad);
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: DESTROY_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) =>
      destroyFlow(repos, await ownServer(repos, serverId), typed, requestId, "server.destroy"),
  );
}

// ----- Notifications ---------------------------------------------------------------------------

/** 16.10 /notifications: `markNotificationsRead`. No ids means all. */
export async function markNotificationsReadCore(
  deps: ExtrasDeps,
  raw: unknown,
): Promise<ExtrasResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  const input = record(raw);
  const one = input["id"];
  if (one !== undefined && (typeof one !== "string" || !UUID.test(one))) {
    return fail("validation", { id: "invalid" });
  }
  try {
    return await deps.store(session.customerId, async (repos) => {
      const decision = await repos.rateLimits.consume(READ_LIMIT, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      await repos.notifications.markRead(typeof one === "string" ? [one] : undefined);
      await audit(
        repos,
        "notification.mark_read",
        "notification",
        typeof one === "string" ? one : "all",
      );
      return { ok: true, done: "marked" } satisfies ExtrasResult;
    });
  } catch {
    return fail("unavailable");
  }
}
