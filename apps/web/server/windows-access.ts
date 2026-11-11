import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";

// The core of the Access tab's "show the Windows password" action (16.10, U9). R9 order: authenticate,
// authorize (a fresh sign-in, 6.1), validate, rate limit, execute. The audit row is written by the
// access-details function, in the same call, and the secret is not released without it.
//
// R1: this tier never imports packages/aws. The password is fetched by the access-details function
// (3.2), which this core reaches through the `reveal` port: a direct invocation, because a secret
// cannot travel through an operation row or a queue message (it would be stored). The port is
// `null` until the transport is wired (WP6 infra); the core then refuses (R16).
//
// The secret leaves this module in the return value only, once (U9). Nothing here logs, stores or
// caches it.

export type RevealAnswer =
  { ok: true; value: { username: string; password: string } } | { ok: false; error: string };

/**
 * The transport to the access-details function. Implementations live outside this tier's imports of
 * packages/aws (R1) and add no Lambda client here without a recorded reason (R17). TODO(infra, see the
 * "Needs decision" of WP6-T1 in JOURNEY.md): invoke the function through a small HTTPS function URL
 * signed with SigV4 (AWS_IAM auth), or add a Lambda client dependency. The customer id passed is
 * always the session's (R8); the function checks the tenant again.
 */
export type RevealPort = (input: {
  customerId: string;
  resourceId: string;
}) => Promise<RevealAnswer>;

export interface WindowsAccessDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One hit against the customer's limit for this action; false when it is used up. */
  rateLimit(session: CustomerSession): Promise<boolean>;
  /** The invocation of access-details; the customer id is the session's (R8). null: not wired. */
  reveal: RevealPort | null;
}

export type WindowsAccessError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_ready"
  | "unavailable";

export type WindowsAccessResult =
  | {
      ok: true;
      username: string;
      password: string;
      /** The Server Action response must not be cached (U9). */
      cacheControl: "no-store";
    }
  | { ok: false; error: WindowsAccessError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the function answers becomes a public key; its text, if any, is dropped.
function publicError(code: string): WindowsAccessError {
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

export async function revealWindowsPasswordCore(
  deps: WindowsAccessDeps,
  raw: unknown,
): Promise<WindowsAccessResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const fresh = requireFreshSignIn(session, { now: deps.now });
  if (!fresh.ok) return { ok: false, error: "fresh_sign_in_required" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const resourceId = input["resourceId"];
  if (typeof resourceId !== "string" || !UUID.test(resourceId)) {
    return { ok: false, error: "validation" };
  }
  if (deps.reveal === null) return { ok: false, error: "unavailable" };

  try {
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
