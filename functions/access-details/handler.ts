import {
  AwsError,
  type BucketAccessKey,
  type BucketAccessKeyListed,
  type DatabasePassword,
  type WindowsPassword,
} from "@tc/aws";
import type { ErrorCode, Logger } from "@tc/core";
import type { ReadTarget } from "@tc/db";

// The access-details function (3.2, 6.3): a secret for one resource id, after its own tenant check.
// Four actions: the Windows password, the database master password, a bucket access key (create) and
// the list of a bucket's keys. The caller is `{ customerId }` taken by the web tier from its verified
// session and passed in the invocation, and accepted only on the "web" alias (invoke.ts); nothing else
// in the event is trusted (R8). The order of R9: authenticate, authorize (ownership through the
// tenant-scoped read), validate, rate limit, execute, audit. A secret is returned once (U9) with
// `cacheControl: "no-store"`, is never stored, logged or kept in this module, and is not released when
// the audit row cannot be written (R16).

export interface AccessCaller {
  readonly customerId: string;
}

export type AuditAction =
  "windows_password.reveal" | "database_password.reveal" | "bucket_key.create";

export type RateAction = AuditAction | "bucket_key.list";

export interface AccessDetailsDeps {
  /** The tenant check: the resource only if `caller` owns it and it is placed, else null (loadReadTarget). */
  readonly loadTarget: (caller: AccessCaller, resourceId: string) => Promise<ReadTarget | null>;
  /** One hit against the customer's limit for this action; false when the limit is used up. */
  readonly rateLimit: (customerId: string, action: RateAction) => Promise<boolean>;
  /** The call to Lightsail with the TcAccessDetails role (fetchWindowsPassword of @tc/aws). */
  readonly windowsPassword: (target: ReadTarget) => Promise<WindowsPassword>;
  /** fetchDatabasePassword of @tc/aws. */
  readonly databasePassword: (target: ReadTarget) => Promise<DatabasePassword>;
  /** createBucketAccessKey of @tc/aws. */
  readonly bucketKeyCreate: (target: ReadTarget) => Promise<BucketAccessKey>;
  /** listBucketAccessKeys of @tc/aws: ids and facts, never a secret. */
  readonly bucketKeyList: (target: ReadTarget) => Promise<BucketAccessKeyListed[]>;
  /**
   * The unique claim of a request id (R7): true the first time for this customer and request id,
   * false for every later call. Atomic, so a double click cannot make two keys.
   */
  readonly claimRequest: (customerId: string, requestId: string) => Promise<boolean>;
  /** One audit row for the reveal. It holds ids only, never the secret. A throw refuses the answer. */
  readonly audit: (entry: {
    readonly customerId: string;
    readonly action: AuditAction;
    readonly resourceId: string;
  }) => Promise<void>;
  readonly log: Logger;
}

export type AccessCode =
  | Extract<
      ErrorCode,
      | "unauthenticated"
      | "not_found"
      | "validation"
      | "conflict"
      | "rate_limited"
      | "upstream_unavailable"
      | "internal"
    >
  | "limit_reached"
  | "already_created";

type Secret<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /** The web tier sends this header with the Server Action response (U9). */
      readonly cacheControl: "no-store";
    }
  | { readonly ok: false; readonly error: AccessCode };

export type WindowsPasswordResult = Secret<WindowsPassword>;
export type DatabasePasswordResult = Secret<DatabasePassword>;
export type BucketKeyCreateResult = Secret<BucketAccessKey>;
export type BucketKeyListResult =
  | { readonly ok: true; readonly value: { readonly keys: readonly BucketAccessKeyListed[] } }
  | { readonly ok: false; readonly error: AccessCode };

export interface AccessDetails {
  windowsPassword(resourceId: string, caller: AccessCaller): Promise<WindowsPasswordResult>;
  databasePassword(resourceId: string, caller: AccessCaller): Promise<DatabasePasswordResult>;
  bucketKeyCreate(
    resourceId: string,
    requestId: string,
    caller: AccessCaller,
  ): Promise<BucketKeyCreateResult>;
  bucketKeyList(resourceId: string, caller: AccessCaller): Promise<BucketKeyListResult>;
}

class Refused extends Error {
  constructor(readonly code: AccessCode) {
    super(code);
  }
}

function customerOf(caller: unknown): string | null {
  if (typeof caller !== "object" || caller === null) return null;
  const c = caller as { customerId?: unknown; adminId?: unknown };
  // A caller that holds an admin identity as well is not a customer.
  if (c.adminId !== undefined) return null;
  const id = c.customerId;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

// An AWS failure becomes a platform code. A role or credential problem is ours, not the customer's.
function codeOf(error: unknown): AccessCode {
  if (error instanceof Refused) return error.code;
  if (error instanceof AwsError) {
    switch (error.code) {
      case "conflict":
        return "conflict";
      case "validation":
        return "validation";
      case "rate_limited":
        return "rate_limited";
      case "not_found":
        return "not_found";
      case "limit_reached":
        return "limit_reached";
      case "upstream_unavailable":
      case "forbidden":
      case "unauthenticated":
        return "upstream_unavailable";
      default:
        return "internal";
    }
  }
  return "internal";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createAccessDetails(deps: AccessDetailsDeps): AccessDetails {
  /**
   * The common frame: caller, tenant check, family, state, rate limit. Returns the target and the
   * customer. Every refusal is a `Refused`; the AWS call and the audit are the caller's.
   */
  async function guard(
    resourceId: string,
    caller: AccessCaller,
    family: string,
    action: RateAction,
    ready: (target: ReadTarget) => boolean = () => true,
  ): Promise<{ customerId: string; target: ReadTarget }> {
    const customerId = customerOf(caller);
    if (customerId === null) throw new Refused("unauthenticated");
    const target = await deps.loadTarget({ customerId }, resourceId);
    if (target === null) throw new Refused("not_found");
    if (target.resource.family !== family) throw new Refused("validation");
    if (!ready(target)) throw new Refused("conflict");
    if (!(await deps.rateLimit(customerId, action))) throw new Refused("rate_limited");
    return { customerId, target };
  }

  // The frame of the three secrets. Fixed words only in the log: no id, no AWS text, no secret (R14).
  async function secretFlow<T>(
    word: string,
    run: () => Promise<{ customerId: string; value: T }>,
  ): Promise<Secret<T>> {
    let result: Secret<T>;
    let outcome: "ok" | AccessCode;
    try {
      const { value } = await run();
      result = { ok: true, value, cacheControl: "no-store" };
      outcome = "ok";
    } catch (error) {
      const code = codeOf(error);
      result = { ok: false, error: code };
      outcome = code;
    }
    deps.log({ event: "access_details", action: word, outcome });
    return result;
  }

  async function auditOrRefuse(
    customerId: string,
    action: AuditAction,
    resourceId: string,
  ): Promise<void> {
    try {
      await deps.audit({ customerId, action, resourceId });
    } catch {
      // No audit row, no secret.
      throw new Refused("internal");
    }
  }

  return {
    windowsPassword: (resourceId, caller) =>
      secretFlow("windows_password", async () => {
        const { customerId, target } = await guard(
          resourceId,
          caller,
          "windows_instance",
          "windows_password.reveal",
        );
        const value = await deps.windowsPassword(target);
        await auditOrRefuse(customerId, "windows_password.reveal", resourceId);
        return { customerId, value };
      }),

    databasePassword: (resourceId, caller) =>
      secretFlow("database_password", async () => {
        const { customerId, target } = await guard(
          resourceId,
          caller,
          "database",
          "database_password.reveal",
          (t) => t.resource.state === "active",
        );
        const value = await deps.databasePassword(target);
        await auditOrRefuse(customerId, "database_password.reveal", resourceId);
        return { customerId, value };
      }),

    // A key is not an idempotent thing. The request id is claimed once (R7) BEFORE AWS is asked, so a
    // double click, a retry or a replay never makes a second key; they answer `already_created` and the
    // secret of the first call is not shown again. The audit row is written before the key exists: a
    // key whose audit row failed is never made (R16).
    bucketKeyCreate: (resourceId, requestId, caller) =>
      secretFlow("bucket_key_create", async () => {
        if (typeof requestId !== "string" || !UUID.test(requestId)) throw new Refused("validation");
        const { customerId, target } = await guard(
          resourceId,
          caller,
          "bucket",
          "bucket_key.create",
          (t) => t.resource.state === "active",
        );
        if (!(await deps.claimRequest(customerId, requestId))) throw new Refused("already_created");
        await auditOrRefuse(customerId, "bucket_key.create", resourceId);
        const value = await deps.bucketKeyCreate(target);
        return { customerId, value };
      }),

    async bucketKeyList(resourceId, caller) {
      let result: BucketKeyListResult;
      let outcome: "ok" | AccessCode;
      try {
        const { target } = await guard(resourceId, caller, "bucket", "bucket_key.list");
        const keys = await deps.bucketKeyList(target);
        result = { ok: true, value: { keys } };
        outcome = "ok";
      } catch (error) {
        const code = codeOf(error);
        result = { ok: false, error: code };
        outcome = code;
      }
      deps.log({ event: "access_details", action: "bucket_key_list", outcome });
      return result;
    },
  };
}
