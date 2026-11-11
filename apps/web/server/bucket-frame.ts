import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import type {
  AuditRepo,
  CustomerLimit,
  OperationsRepo,
  RateLimitsRepo,
  ResourcesRepo,
  SubscriptionsRepo,
} from "@tc/db";

// The common frame of the action cores of the bucket (/storage) and container service (/containers)
// screens, the same shape as the one of cdn-actions.ts: authenticate, authorize (a fresh sign-in for
// a destructive action, U10; the flag), validate, rate limit inside the transaction, then the body,
// then the audit (R9). A refusal thrown by the body rolls everything back, the counted rate limit
// included. Every action is an operation row (R1: nothing here calls AWS) and idempotent by the
// request id of the page (R7). What leaves a core is a fixed public key, never an error text (U6).

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
  | "confirm_required"
  | "not_allowed"
  | "unavailable";

export type FamilyResult =
  | { ok: true; done: string; approval?: boolean }
  | { ok: false; error: FamilyError; fields?: Record<string, string> };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const limit = (action: string, count: number, windowSeconds: number): CustomerLimit[] => [
  Object.freeze({ action, limit: count, windowSeconds }),
];

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

export function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

export type Parsed = { ok: true } | { ok: false; fields: Record<string, string> };

export async function frame(
  deps: FamilyActionDeps,
  spec: { destructive: boolean; limits: readonly CustomerLimit[] },
  parse: () => Parsed,
  body: (repos: FamilyRepos) => Promise<FamilyResult>,
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
      return body(repos);
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error) : fail("unavailable");
  }
}

export async function audit(repos: FamilyRepos, action: string, targetId: string): Promise<void> {
  const written = await repos.audit.record({ action, targetType: "resource", targetId });
  // The audit entry is part of the action: without it everything rolls back (R9, R16).
  if (!written.ok) throw new Error("the audit entry was refused");
}

/** The customer's own row of the family; another customer's row and a missing one are the same (R8). */
export async function ownResource(repos: FamilyRepos, id: string, family: string) {
  const row = await repos.resources.get(id);
  if (row === null || row.family !== family) throw new Refusal("not_found");
  return row;
}

export function displayNameOf(config: unknown): string {
  const name = record(config)["displayName"];
  return typeof name === "string" ? name.slice(0, 60) : "";
}

/** The plain id parts of a form that every action has: the resource id and the request id (R7). */
export function idFields(
  input: Record<string, unknown>,
  idKey: string,
): { bad: Record<string, string>; id: string; requestId: string } {
  const bad: Record<string, string> = {};
  const id = input[idKey];
  const requestId = input["requestId"];
  if (typeof id !== "string" || !UUID.test(id)) bad[idKey] = "invalid";
  if (typeof requestId !== "string" || !UUID.test(requestId)) bad["requestId"] = "invalid";
  return { bad, id: id as string, requestId: requestId as string };
}

export const parsedFrom = (bad: Record<string, string>): Parsed =>
  Object.keys(bad).length === 0 ? { ok: true } : { ok: false, fields: bad };
