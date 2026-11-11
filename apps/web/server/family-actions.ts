import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { decideDestructive } from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  OperationsRepo,
  RateLimitsRepo,
  ResourceSummary,
  ResourcesRepo,
  SubscriptionsRepo,
} from "@tc/db";

// The shared part of the Server Action cores of the database and load balancer screens (16.10). R9 in
// each: authenticate, authorize (a fresh sign-in for a destructive action, U10; the flag and the
// ownership of the resource), validate, rate limit, execute, audit. Every action is an operation row
// (R1: nothing here calls AWS) and is idempotent by the request id that the page put in the form (R7).
// The ports are parameters, so the cores run in a test without a database. What leaves a core is a
// fixed public key, never the text of an error (U6).

export interface FamilyRepos {
  resources: ResourcesRepo;
  subscriptions: SubscriptionsRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  /** R12, R16: the flag of the family for the customer's market; false when it cannot be read. */
  flagOn(): Promise<boolean>;
}

export interface FamilyActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: FamilyRepos) => Promise<T>): Promise<T>;
}

export type FamilyError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "flag_off"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "name_mismatch"
  | "not_allowed"
  | "unavailable";

export type FamilyResult =
  | { ok: true; done: string; approval?: boolean }
  | { ok: false; error: FamilyError; fields?: Record<string, string> };

export interface FamilySpec {
  /** The `family` value of resources. */
  family: "database" | "load_balancer";
  /** The form field that carries the id of the resource. */
  idField: string;
  /** Prefix of audit actions and idempotency keys. */
  prefix: string;
  /** True where Lightsail keeps a snapshot (R13); false where the settings are kept in the config. */
  withFinalSnapshot: boolean;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE_STATES = ["active", "stopped", "suspended"];

const limit = (action: string, count: number, windowSeconds: number): CustomerLimit[] => [
  Object.freeze({ action, limit: count, windowSeconds }),
];
export const FAMILY_WRITE_LIMIT = (prefix: string): CustomerLimit[] =>
  limit(`${prefix}.write`, 30, 3600);
export const FAMILY_DESTROY_LIMIT = (prefix: string): CustomerLimit[] =>
  limit(`${prefix}.destroy`, 5, 3600);

export class Refusal extends Error {
  constructor(readonly error: FamilyError) {
    super(error);
  }
}

export const fail = (error: FamilyError, fields?: Record<string, string>): FamilyResult => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

export function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function uuidField(
  input: Record<string, unknown>,
  key: string,
  bad: Record<string, string>,
): string {
  const value = input[key];
  if (typeof value === "string" && UUID.test(value)) return value;
  bad[key] = "invalid";
  return "";
}

export const parseOf =
  (bad: Record<string, string>) =>
  (): { ok: true } | { ok: false; fields: Record<string, string> } =>
    Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad };

// The common frame: authenticate, authorize, validate, rate limit inside the transaction, then the
// body, then the audit. A refusal thrown by the body rolls everything back, the counted rate limit
// included (the next try is a fresh count).
export async function frame(
  deps: FamilyActionDeps,
  spec: { destructive: boolean; limits: readonly CustomerLimit[] },
  parse: () => { ok: true } | { ok: false; fields: Record<string, string> },
  body: (repos: FamilyRepos, session: CustomerSession) => Promise<FamilyResult>,
): Promise<FamilyResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  if (spec.destructive && !requireFreshSignIn(session, { now: deps.now }).ok) {
    return fail("fresh_sign_in_required");
  }
  const parsed = parse();
  if (!parsed.ok) return fail("validation", parsed.fields);
  try {
    return await deps.store(session.customerId, async (repos) => {
      if (!(await repos.flagOn())) throw new Refusal("flag_off");
      const decision = await repos.rateLimits.consume(spec.limits, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      return body(repos, session);
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error) : fail("unavailable");
  }
}

export async function audit(repos: FamilyRepos, action: string, targetId: string): Promise<void> {
  const written = await repos.audit.record({ action, targetType: "resource", targetId });
  // The audit entry is part of the action: without it everything rolls back (R9, R16).
  if (!written.ok) throw new Error("family: the audit entry was refused");
}

/** The customer's own row of the family. Another customer's row and a missing one are one answer (R8). */
export async function ownResource(
  repos: FamilyRepos,
  family: string,
  id: string,
): Promise<ResourceSummary> {
  const row = await repos.resources.get(id);
  if (row === null || row.family !== family) throw new Refusal("not_found");
  return row;
}

export function nameOf(config: unknown): string {
  const name = record(config)["displayName"];
  return typeof name === "string" ? name.slice(0, 60) : "";
}

/** `stop` from active, `start` from stopped; every other state belongs to the lifecycle (R13). */
export async function setRunningCore(
  deps: FamilyActionDeps,
  spec: FamilySpec,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const id = uuidField(input, spec.idField, bad);
  const requestId = uuidField(input, "requestId", bad);
  const run = input["run"];
  if (run !== "start" && run !== "stop") bad["run"] = "invalid";
  const start = run === "start";
  return frame(
    deps,
    { destructive: false, limits: FAMILY_WRITE_LIMIT(spec.prefix) },
    parseOf(bad),
    async (repos) => {
      const row = await ownResource(repos, spec.family, id);
      if (row.state !== (start ? "stopped" : "active")) throw new Refusal("not_allowed");
      const written = await repos.operations.request({
        resourceId: row.id,
        kind: start ? "start" : "stop",
        idempotencyKey: `${spec.prefix}-run:${requestId}`,
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, `${spec.prefix}.${start ? "start" : "stop"}`, row.id);
      return { ok: true, done: start ? "started" : "stopped" };
    },
  );
}

/**
 * `destroy` (U10, R13; enters the approval queue until 2026-12-01). A database gets a final snapshot
 * first; a load balancer has none, its settings stay in `resources.config` (11).
 */
export async function destroyFamilyCore(
  deps: FamilyActionDeps,
  spec: FamilySpec,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const bad: Record<string, string> = {};
  const id = uuidField(input, spec.idField, bad);
  const requestId = uuidField(input, "requestId", bad);
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: FAMILY_DESTROY_LIMIT(spec.prefix) },
    parseOf(bad),
    async (repos) => {
      const row = await ownResource(repos, spec.family, id);
      if (!LIVE_STATES.includes(row.state)) throw new Refusal("not_allowed");
      const name = nameOf(row.config);
      if (name === "" || typed !== name) throw new Refusal("name_mismatch");
      // R13: once the subscription is `retained` (and the snapshot exists where the family has one),
      // the guard must let the destroy pass.
      if (
        !decideDestructive("destroy", {
          subscriptionStatus: "retained",
          family: row.family,
          hasFinalSnapshot: spec.withFinalSnapshot,
          isFinalBackup: false,
        })
      ) {
        throw new Refusal("not_allowed");
      }
      const queued = await repos.subscriptions.requestDestroy({
        resourceId: row.id,
        idempotencyKey: `destroy:${requestId}`,
        withFinalSnapshot: spec.withFinalSnapshot,
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
      await audit(repos, `${spec.prefix}.destroy`, row.id);
      return { ok: true, done: "destroyQueued", approval: queued.value.needsApproval };
    },
  );
}
