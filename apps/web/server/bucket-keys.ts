import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";

// The core of the Keys tab's "create an access key" action (16.10, U9). R9 order: authenticate,
// authorize (a fresh sign-in, 6.1), validate, rate limit, execute. The audit row and the unique key
// are written by the access-details function in the same call, and the secret is not released
// without them (a key is not idempotent: a retry is answered from that audit row, which is why the
// request id travels with the call, R7).
//
// R1: this tier never imports packages/aws. The key is made by the access-details function
// (createBucketAccessKey), which this core reaches through the `createKey` port: a direct invocation,
// because a secret cannot travel through an operation row or a queue message (it would be stored). The
// port is `null` until the transport is wired (see the "Needs decision" of WP6-T1 and WP6-T4s in
// JOURNEY.md); the core then refuses (R16).
//
// The secret leaves this module in the return value only, once (U9). Nothing here logs, stores or
// caches it, and no error carries it.

export type CreateKeyAnswer =
  | { ok: true; value: { accessKeyId: string; secretAccessKey: string } }
  | { ok: false; error: string };

export type CreateKeyPort = (input: {
  customerId: string;
  resourceId: string;
  requestId: string;
}) => Promise<CreateKeyAnswer>;

/** One key of the list: the id and facts that are not secret (the secret is shown once, at creation). */
export interface KeyView {
  accessKeyId: string;
  status: "active" | "inactive";
  createdAt: string | null;
}

export type ListKeysPort = (input: {
  customerId: string;
  resourceId: string;
}) => Promise<{ ok: true; value: { keys: KeyView[] } } | { ok: false; error: string }>;

export interface BucketKeysDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /**
   * The customer's own bucket through the scoped repository with the family flag on: its state and the
   * name the customer must type, else null. Another customer's bucket and a missing one are the same
   * answer (R8).
   */
  ownedBucket(
    customerId: string,
    bucketId: string,
  ): Promise<{ state: string; name: string } | null>;
  /** One hit against the customer's limit for this action; false when it is used up. */
  rateLimit(
    session: CustomerSession,
    action: "bucket_key.create" | "bucket_key.list",
  ): Promise<boolean>;
  /** The invocation of access-details; the customer id is the session's (R8). null: not wired. */
  createKey: CreateKeyPort | null;
  /** The list of the bucket's keys by the same function. null: not wired. */
  listKeys: ListKeysPort | null;
}

export type BucketKeysError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_ready"
  | "name_mismatch"
  | "limit_reached"
  | "already_created"
  | "unavailable";

export type BucketKeysResult =
  | {
      ok: true;
      accessKeyId: string;
      secretAccessKey: string;
      /** The Server Action response must not be cached (U9). */
      cacheControl: "no-store";
    }
  | { ok: false; error: BucketKeysError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the function answers becomes a public key; its text, if any, is dropped.
function publicError(code: string): BucketKeysError {
  switch (code) {
    case "not_found":
    case "validation":
    case "unauthenticated":
      return "not_found";
    case "conflict":
      return "not_ready";
    case "limit_reached":
      return "limit_reached";
    case "already_created":
      return "already_created";
    case "rate_limited":
      return "rate_limited";
    default:
      return "unavailable";
  }
}

export async function createBucketKeyCore(
  deps: BucketKeysDeps,
  raw: unknown,
): Promise<BucketKeysResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const fresh = requireFreshSignIn(session, { now: deps.now });
  if (!fresh.ok) return { ok: false, error: "fresh_sign_in_required" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const bucketId = input["bucketId"];
  const requestId = input["requestId"];
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  if (
    typeof bucketId !== "string" ||
    !UUID.test(bucketId) ||
    typeof requestId !== "string" ||
    !UUID.test(requestId)
  ) {
    return { ok: false, error: "validation" };
  }
  if (deps.createKey === null) return { ok: false, error: "unavailable" };

  try {
    // The customer's own active bucket and the typed name (U10): R8 first, then the state, then the name.
    const owned = await deps.ownedBucket(session.customerId, bucketId);
    if (owned === null) return { ok: false, error: "not_found" };
    if (owned.state !== "active") return { ok: false, error: "not_ready" };
    if (owned.name === "" || typed !== owned.name) return { ok: false, error: "name_mismatch" };
    if (!(await deps.rateLimit(session, "bucket_key.create"))) {
      return { ok: false, error: "rate_limited" };
    }
    const answer = await deps.createKey({
      customerId: session.customerId,
      resourceId: bucketId,
      requestId,
    });
    if (!answer.ok) return { ok: false, error: publicError(answer.error) };
    return {
      ok: true,
      accessKeyId: answer.value.accessKeyId,
      secretAccessKey: answer.value.secretAccessKey,
      cacheControl: "no-store",
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export type ListKeysResult = { ok: true; keys: KeyView[] } | { ok: false; error: BucketKeysError };

/**
 * The keys of the customer's own bucket, for the Keys tab. R9 order: authenticate, authorize (own
 * bucket), validate, rate limit, execute. No secret is in the answer (AWS never returns it for a
 * listed key). Any failure is "unavailable" or "not_found": the tab then says it cannot list (R16).
 */
export async function listBucketKeysCore(
  deps: BucketKeysDeps,
  raw: unknown,
): Promise<ListKeysResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const bucketId = input["bucketId"];
  if (typeof bucketId !== "string" || !UUID.test(bucketId)) {
    return { ok: false, error: "validation" };
  }
  if (deps.listKeys === null) return { ok: false, error: "unavailable" };
  try {
    const owned = await deps.ownedBucket(session.customerId, bucketId);
    if (owned === null) return { ok: false, error: "not_found" };
    if (owned.state !== "active") return { ok: false, error: "not_ready" };
    if (!(await deps.rateLimit(session, "bucket_key.list"))) {
      return { ok: false, error: "rate_limited" };
    }
    const answer = await deps.listKeys({ customerId: session.customerId, resourceId: bucketId });
    if (!answer.ok) return { ok: false, error: publicError(answer.error) };
    return { ok: true, keys: answer.value.keys.map((k) => ({ ...k })) };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
