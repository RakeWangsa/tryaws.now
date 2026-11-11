import { decideDestructive, parseBucketAccess, parseBucketConfig } from "@tc/core";
import {
  audit,
  frame,
  idFields,
  limit,
  ownResource,
  Refusal,
  parsedFrom,
  record,
  text,
  displayNameOf,
} from "./bucket-frame.ts";
import type { FamilyActionDeps, FamilyResult } from "./bucket-frame.ts";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The cores of the Server Actions of the object storage screens (/storage, 16.10): `createOrderDraft`
// (review), `setBucketAccess`, `deleteAccessKey` and `destroyBucket`. R9 order in each: authenticate,
// authorize (a fresh sign-in for a destructive action, U10; the flag and the ownership), validate,
// rate limit, execute, audit. Every one writes an operation row or a draft and nothing else (R1) and
// is idempotent by the request id of the page (R7). What leaves a core is a fixed public key (U6).
// The secret key is a different thing: see bucket-keys.ts.

const FAMILY = "bucket";
const LIVE_STATES = ["active", "stopped", "suspended"];
/** The shape of a Lightsail access key id, the same as the adapter accepts (R11: nothing else). */
const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** The text that a customer types to make a bucket public. Compared exactly, in every locale. */
export const PUBLIC_CONFIRMATION = "PUBLIC";

export const BUCKET_WRITE_LIMIT = limit("bucket.write", 30, 3600);
export const BUCKET_DESTROY_LIMIT = limit("bucket.destroy", 5, 3600);

/** /storage/new: the three fields of the form, nothing else, become the config of a bucket (R9, R11). */
export async function createBucketDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = record(raw);
  const parsed = parseBucketConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
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

  const result = await deps.orders.createOrderDraft(session, {
    family: FAMILY,
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

/**
 * 16.10 `setBucketAccess`. The mode is private or public. Public needs the exact confirmation text
 * (the customer reads what it means first); objects can never override to public (parseBucketAccess).
 * Only an active bucket is changed: a suspended one stays closed until it is resumed (R13).
 */
export async function setBucketAccessCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const { bad, id, requestId } = idFields(input, "bucketId");
  const rules = parseBucketAccess({ mode: input["mode"] });
  if (rules === null) bad["mode"] = "invalid";
  const confirmed = input["confirmText"] === PUBLIC_CONFIRMATION;
  return frame(
    deps,
    { destructive: false, limits: BUCKET_WRITE_LIMIT },
    () => parsedFrom(bad),
    async (repos) => {
      const row = await ownResource(repos, id, FAMILY);
      if (row.state !== "active") throw new Refusal("not_allowed");
      const mode = (rules as NonNullable<typeof rules>).getObject;
      if (mode === "public" && !confirmed) throw new Refusal("confirm_required");
      const written = await repos.operations.request({
        resourceId: row.id,
        kind: "set_bucket_access",
        idempotencyKey: `bucket-access:${requestId}`,
        payload: { mode },
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, "bucket.access", row.id);
      return { ok: true, done: mode === "public" ? "accessPublic" : "accessPrivate" };
    },
  );
}

/** 16.10 `deleteAccessKey`: the key id (not a secret) goes into the operation; the audit row has none. */
export async function deleteAccessKeyCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const { bad, id, requestId } = idFields(input, "bucketId");
  const key = text(input, "accessKeyId");
  if (typeof key !== "string" || !KEY_ID.test(key)) bad["accessKeyId"] = "invalid";
  return frame(
    deps,
    { destructive: false, limits: BUCKET_WRITE_LIMIT },
    () => parsedFrom(bad),
    async (repos) => {
      const row = await ownResource(repos, id, FAMILY);
      // A suspended bucket has no keys (suspend deleted them).
      if (row.state !== "active") throw new Refusal("not_allowed");
      const written = await repos.operations.request({
        resourceId: row.id,
        kind: "delete_access_key",
        idempotencyKey: `bucket-key:${requestId}`,
        payload: { accessKeyId: key },
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      await audit(repos, "bucket.key_delete", row.id);
      return { ok: true, done: "keyDeleted" };
    },
  );
}

/**
 * 16.10 `destroyBucket` (U10, R13; enters the approval queue until 2026-12-01). A bucket has no
 * snapshot and the guard of the lifecycle lists the family on neither of its lists today, so
 * `decideDestructive` refuses and this core answers `not_allowed` (R16). The owner decides the rule
 * (JOURNEY, WP6-T4s, "Needs decision"); this core follows the guard and does not decide it.
 */
export async function destroyBucketCore(
  deps: FamilyActionDeps,
  raw: unknown,
): Promise<FamilyResult> {
  const input = record(raw);
  const { bad, id, requestId } = idFields(input, "bucketId");
  const typed = typeof input["confirmName"] === "string" ? input["confirmName"] : "";
  return frame(
    deps,
    { destructive: true, limits: BUCKET_DESTROY_LIMIT },
    () => parsedFrom(bad),
    async (repos) => {
      const row = await ownResource(repos, id, FAMILY);
      if (!LIVE_STATES.includes(row.state)) throw new Refusal("not_allowed");
      const name = displayNameOf(row.config);
      if (name === "" || typed !== name) throw new Refusal("name_mismatch");
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
        idempotencyKey: `destroy:${requestId}`,
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
      await audit(repos, "bucket.destroy", row.id);
      return { ok: true, done: "destroyQueued", approval: queued.value.needsApproval };
    },
  );
}
