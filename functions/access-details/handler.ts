import { AwsError, type WindowsPassword } from "@tc/aws";
import type { ErrorCode, Logger } from "@tc/core";
import type { ReadTarget } from "@tc/db";

// The access-details function (3.2, 6.3): a secret for one resource id, after its own tenant check.
// This file is the Windows password. The caller is `{ customerId }` taken by the web tier from its
// verified session and passed in the invocation; nothing else in the event is trusted (R8). The
// order of R9: authenticate, authorize, validate, rate limit, execute, audit. The secret is returned
// once (U9) with `cacheControl: "no-store"`, is never stored, logged or kept in this module, and is
// not released when the audit row cannot be written (R16).

export interface AccessCaller {
  readonly customerId: string;
}

export interface AccessDetailsDeps {
  /** The tenant check: the resource only if `caller` owns it and it is placed, else null (loadReadTarget). */
  readonly loadTarget: (caller: AccessCaller, resourceId: string) => Promise<ReadTarget | null>;
  /** One hit against the customer's limit for this action; false when the limit is used up. */
  readonly rateLimit: (customerId: string) => Promise<boolean>;
  /** The call to Lightsail with the TcAccessDetails role (fetchWindowsPassword of @tc/aws). */
  readonly windowsPassword: (target: ReadTarget) => Promise<WindowsPassword>;
  /** One audit row for the reveal. It holds ids only, never the secret. A throw refuses the answer. */
  readonly audit: (entry: {
    readonly customerId: string;
    readonly action: "windows_password.reveal";
    readonly resourceId: string;
  }) => Promise<void>;
  readonly log: Logger;
}

export type AccessCode = Extract<
  ErrorCode,
  | "unauthenticated"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal"
>;

export type WindowsPasswordResult =
  | {
      readonly ok: true;
      readonly value: WindowsPassword;
      /** The web tier sends this header with the Server Action response (U9). */
      readonly cacheControl: "no-store";
    }
  | { readonly ok: false; readonly error: AccessCode };

export interface AccessDetails {
  windowsPassword(resourceId: string, caller: AccessCaller): Promise<WindowsPasswordResult>;
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

const FAMILY = "windows_instance";

export function createAccessDetails(deps: AccessDetailsDeps): AccessDetails {
  return {
    async windowsPassword(resourceId, caller) {
      let outcome: "ok" | AccessCode;
      let result: WindowsPasswordResult;
      try {
        const customerId = customerOf(caller);
        if (customerId === null) throw new Refused("unauthenticated");
        const target = await deps.loadTarget({ customerId }, resourceId);
        if (target === null) throw new Refused("not_found");
        if (target.resource.family !== FAMILY) throw new Refused("validation");
        if (!(await deps.rateLimit(customerId))) throw new Refused("rate_limited");
        const secret = await deps.windowsPassword(target);
        try {
          await deps.audit({ customerId, action: "windows_password.reveal", resourceId });
        } catch {
          // No audit row, no secret.
          throw new Refused("internal");
        }
        result = { ok: true, value: secret, cacheControl: "no-store" };
        outcome = "ok";
      } catch (error) {
        const code = codeOf(error);
        result = { ok: false, error: code };
        outcome = code;
      }
      // Fixed words only: no id, no AWS text, no secret (R14).
      deps.log({ event: "access_details", action: "windows_password", outcome });
      return result;
    },
  };
}
