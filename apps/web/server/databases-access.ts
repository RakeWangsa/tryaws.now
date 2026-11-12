import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import type { RevealPort } from "./windows-access.ts";

// The core of the Access tab's "show the database password" action (16.10 `revealDatabasePassword`,
// U9). R9 order: authenticate, authorize (a fresh sign-in, 6.1, and the customer's own running
// database, read through the scoped repository, R8), validate, rate limit, execute. The audit row is
// written by the access-details function in the same call, and the secret is not released without it.
//
// R1: this tier never imports packages/aws. The password is fetched by the access-details function,
// reached through the `reveal` port (same transport as the Windows password, see windows-access.ts):
// a secret cannot travel through an operation row or a queue message, it would be stored. The port is
// `null` until the transport is wired; the core then refuses (R16).
//
// The secret leaves this module in the return value only, once (U9). Nothing here logs, stores or
// caches it.

export type { RevealPort };

export interface DatabaseAccessDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /**
   * The state of the database row if it is the customer's own and its flag is on, else null. The
   * answer for another customer's row and a missing one is the same (R8).
   */
  ownedDatabase(customerId: string, resourceId: string): Promise<string | null>;
  /** One hit against the customer's limit for this action; false when it is used up. */
  rateLimit(session: CustomerSession): Promise<boolean>;
  /** The invocation of access-details; the customer id is the session's (R8). null: not wired. */
  reveal: RevealPort | null;
}

export type DatabaseAccessError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_ready"
  | "unavailable";

export type DatabaseAccessResult =
  | {
      ok: true;
      username: string;
      password: string;
      /** The Server Action response must not be cached (U9). */
      cacheControl: "no-store";
    }
  | { ok: false; error: DatabaseAccessError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the function answers becomes a public key; its text, if any, is dropped.
function publicError(code: string): DatabaseAccessError {
  switch (code) {
    case "not_found":
    case "validation":
    case "unauthenticated":
      return "not_found";
    case "conflict":
      return "not_ready";
    case "rate_limited":
      return "rate_limited";
    default:
      return "unavailable";
  }
}

export async function revealDatabasePasswordCore(
  deps: DatabaseAccessDeps,
  raw: unknown,
): Promise<DatabaseAccessResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  if (!requireFreshSignIn(session, { now: deps.now }).ok) {
    return { ok: false, error: "fresh_sign_in_required" };
  }

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const resourceId = input["resourceId"];
  if (typeof resourceId !== "string" || !UUID.test(resourceId)) {
    return { ok: false, error: "validation" };
  }
  if (deps.reveal === null) return { ok: false, error: "unavailable" };

  try {
    const state = await deps.ownedDatabase(session.customerId, resourceId);
    if (state === null) return { ok: false, error: "not_found" };
    if (state !== "active") return { ok: false, error: "not_ready" };
    if (!(await deps.rateLimit(session))) return { ok: false, error: "rate_limited" };
    const answer = await deps.reveal({ customerId: session.customerId, resourceId });
    if (!answer.ok) return { ok: false, error: publicError(answer.error) };
    return {
      ok: true,
      username: answer.value.username,
      password: answer.value.password,
      cacheControl: "no-store",
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
