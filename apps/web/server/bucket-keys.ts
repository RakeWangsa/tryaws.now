import { requireFreshSignIn } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { z } from "zod";
import { formObject, formText } from "./form-schema.ts";

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

export interface BucketKeysDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One hit against the customer's limit for this action; false when it is used up. */
  rateLimit(session: CustomerSession): Promise<boolean>;
  /** The invocation of access-details; the customer id is the session's (R8). null: not wired. */
  createKey: CreateKeyPort | null;
}

export type BucketKeysError =
  | "unauthenticated"
  | "fresh_sign_in_required"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_ready"
  | "limit_reached"
  | "key_not_created"
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
// R9 validate: the shape is a zod schema (only these two fields are read, R11).
const KeyForm = formObject({
  bucketId: formText.pipe(z.string().regex(UUID)),
  requestId: formText.pipe(z.string().regex(UUID)),
});

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
    // L5 (WPU-B7). The function answers `key_not_created` only when AWS failed before a key existed and
    // it has released the claim of the request id, so the same request id may be sent again. Any other
    // failure (a lost answer, a timeout after the call) may have left a key at AWS: it stays
    // "unavailable" and the claim stays, because a retry must not create a second key
    // (docs/runbooks/bucket-access-key-orphan.md).
    case "key_not_created":
      return "key_not_created";
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

  const parsed = KeyForm.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { bucketId, requestId } = parsed.data;
  if (deps.createKey === null) return { ok: false, error: "unavailable" };

  try {
    if (!(await deps.rateLimit(session))) return { ok: false, error: "rate_limited" };
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
