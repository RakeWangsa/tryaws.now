import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { decideDestructive, parseCdnConfig, planApplyInFlight } from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  OperationsRepo,
  RateLimitsRepo,
  ResourcesRepo,
  SubscriptionsRepo,
} from "@tc/db";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the CDN screens (/cdn, 16.10): `createOrderDraft` (review),
// `setCdnEnabled` and `destroyCdn`. R9 order in each: authenticate, authorize (a fresh sign-in for a
// destructive action, U10; the flag and the ownership of the resource), validate, rate limit, execute,
// audit. Every action is an operation row or a draft (R1: nothing here calls AWS) and is idempotent by
// the request id that the page put in the form (R7). The ports are parameters, so the cores run in a
// test without a database. What leaves a core is a fixed public key, never the text of an error (U6).

export interface CdnRepos {
  resources: ResourcesRepo;
  subscriptions: SubscriptionsRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  /** R12, R16: the flag `cdn` for the customer's market; false when it cannot be read. */
  cdnOn(): Promise<boolean>;
}

export interface CdnActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: CdnRepos) => Promise<T>): Promise<T>;
}

export type CdnError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "flag_off"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "name_mismatch"
  | "not_allowed"
  | "busy"
  | "unavailable";

export type CdnResult =
  | { ok: true; done: string; approval?: boolean }
  | { ok: false; error: CdnError; fields?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAMILY = "cdn";
const LIVE_STATES = ["active", "stopped", "suspended"];

const limit = (action: string, count: number, windowSeconds: number): CustomerLimit[] => [
  Object.freeze({ action, limit: count, windowSeconds }),
];
export const CDN_WRITE_LIMIT = limit("cdn.write", 30, 3600);
export const CDN_DESTROY_LIMIT = limit("cdn.destroy", 5, 3600);

class Refusal extends Error {
  constructor(readonly error: CdnError) {
    super(error);
  }
}

const fail = (error: CdnError, fields?: Record<string, string>): CdnResult => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

/** /cdn/new: the form's fields, nothing else, become the config of a distribution (R9, R11). */
export async function createCdnDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = record(raw);
  const cache = text(input, "cacheBehavior");
  const parsed = parseCdnConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    originId: text(input, "originId"),
    ...(cache === "" || cache === undefined ? {} : { cacheBehavior: cache }),
  });
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  // The ownership of the origin is checked inside the order code, through the scoped repository (R8).
  const result = await deps.orders.createOrderDraft(session, {
    family: FAMILY,
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error, result.data),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

// The common frame: authenticate, authorize, validate, rate limit inside the transaction, then the
// body, then the audit. A refusal thrown by the body rolls everything back, the counted rate limit
// included (the next try is a fresh count).
async function frame(
  deps: CdnActionDeps,
  spec: { destructive: boolean; limits: readonly CustomerLimit[] },
  parse: () => { ok: true } | { ok: false; fields: Record<string, string> },
  body: (repos: CdnRepos) => Promise<CdnResult>,
): Promise<CdnResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  if (spec.destructive && !requireFreshSignIn(session, { now: deps.now }).ok) {
    return fail("fresh_sign_in_required");
  }
  const parsed = parse();
  if (!parsed.ok) return fail("validation", parsed.fields);
  try {
    return await deps.store(session.customerId, async (repos) => {
      if (!(await repos.cdnOn())) throw new Refusal("flag_off");
      const decision = await repos.rateLimits.consume(spec.limits, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      return body(repos);
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error) : fail("unavailable");
  }
}

async function audit(repos: CdnRepos, action: string, targetId: string): Promise<void> {
  const written = await repos.audit.record({ action, targetType: "resource", targetId });
  // The audit entry is part of the action: without it everything rolls back (R9, R16).
  if (!written.ok) throw new Error("cdn: the audit entry was refused");
}

async function ownDistribution(repos: CdnRepos, id: string) {
  const row = await repos.resources.get(id);
  // Another customer's row and a missing one are the same answer (R8).
  if (row === null || row.family !== FAMILY) throw new Refusal("not_found");
  return row;
}

/**
 * WPU-S3: the customer cannot turn a distribution off or destroy it while the apply of a pending plan
 * (change_cdn_bundle) is queued or running: the renewal charged the new price already, and a stopped
 * distribution would make the apply conflict. The standard busy refusal; a list that cannot be read
 * throws and the action is refused as unavailable (R16).
 */
async function refuseWhilePlanApplies(repos: CdnRepos, resourceId: string): Promise<void> {
  if (planApplyInFlight(await repos.operations.listForResource(resourceId))) {
    throw new Refusal("busy");
  }
}

function nameOf(config: unknown): string {
  const name = record(config)["displayName"];
  return typeof name === "string" ? name.slice(0, 60) : "";
}

/** 16.10 `setCdnEnabled`: off is `stop`, on is `start`; both change the distribution only. */
export async function setCdnEnabledCore(deps: CdnActionDeps, raw: unknown): Promise<CdnResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const id = input["cdnId"];
  const requestId = input["requestId"];
  const enabled = input["enabled"];
  if (typeof id !== "string" || !UUID.test(id)) bad["cdnId"] = "invalid";
  if (typeof requestId !== "string" || !UUID.test(requestId)) bad["requestId"] = "invalid";
  if (enabled !== "on" && enabled !== "off") bad["enabled"] = "invalid";
  const on = enabled === "on";
  return frame(
    deps,
    { destructive: false, limits: CDN_WRITE_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const row = await ownDistribution(repos, id as string);
      // Off from active, on from stopped: a suspended or creating one is the lifecycle's (R13).
      if (row.state !== (on ? "stopped" : "active")) throw new Refusal("not_allowed");
      // WPU-S3: not while the apply of a pending plan is on its way (the renewal already charged it).
      if (!on) await refuseWhilePlanApplies(repos, row.id);
      const written = await repos.operations.request({
        resourceId: row.id,
        kind: on ? "start" : "stop",
        idempotencyKey: `cdn-enabled:${requestId as string}`,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, on ? "cdn.enable" : "cdn.disable", row.id);
      return { ok: true, done: on ? "enabled" : "disabled" };
    },
  );
}

/**
 * 16.10 `destroyCdn` (U10, R13; enters the approval queue until 2026-12-01). A distribution has no
 * snapshot: its settings stay in `resources.config` and it is created again from them (11).
 */
export async function destroyCdnCore(deps: CdnActionDeps, raw: unknown): Promise<CdnResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const id = input["cdnId"];
  const requestId = input["requestId"];
  if (typeof id !== "string" || !UUID.test(id)) bad["cdnId"] = "invalid";
  if (typeof requestId !== "string" || !UUID.test(requestId)) bad["requestId"] = "invalid";
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: CDN_DESTROY_LIMIT },
    () => (Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad }),
    async (repos) => {
      const row = await ownDistribution(repos, id as string);
      if (!LIVE_STATES.includes(row.state)) throw new Refusal("not_allowed");
      const name = nameOf(row.config);
      if (name === "" || typed !== name) throw new Refusal("name_mismatch");
      // WPU-S3: the apply of a pending plan, once charged, runs before the distribution can go.
      await refuseWhilePlanApplies(repos, row.id);
      // R13: once the subscription is `retained`, the guard must let a destroy of this family pass
      // without a snapshot.
      if (
        !decideDestructive("destroy", {
          subscriptionStatus: "retained",
          family: row.family,
          hasFinalSnapshot: false,
          isFinalBackup: false,
        })
      ) {
        throw new Refusal("not_allowed");
      }
      const queued = await repos.subscriptions.requestDestroy({
        resourceId: row.id,
        idempotencyKey: `destroy:${requestId as string}`,
        withFinalSnapshot: false,
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
      await audit(repos, "cdn.destroy", row.id);
      return { ok: true, done: "destroyQueued", approval: queued.value.needsApproval };
    },
  );
}
