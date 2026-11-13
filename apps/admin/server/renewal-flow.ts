import { sendAfterCommit } from "@tc/core";
import type { AdminMessage, AdminRole } from "@tc/db";
import { check, confirmUnrenewedAction } from "./schemas.ts";
import type { OpsFlowDeps } from "./ops-flow.ts";

// WPU-X3 (b). The admin action "registry confirmed not renewed" for a domain renewal stuck in needs_attention at the
// registry check (poll), in the order of R9: authenticate and authorize, validate, rate limit, execute (one
// transaction; the write goes through `audited`, which stores actor, reason, IP and target, R10), and the answer.
// The action only writes an operation row (`confirm_unrenewed`) and sends its queue message after the commit (R1:
// never AWS). The provisioner runs a fresh registry check and refunds only on a final "not renewed" with the expiry
// unchanged; otherwise it records why. The request has no field for an actor or a role. Answers are fixed codes,
// never the text of an error (R14, R16).

// A refund decision on a domain renewal is a money decision: finance, and superadmin who owns every area.
export const RENEWAL_CONFIRM_ROLES: readonly AdminRole[] = ["finance", "superadmin"];

export interface ConfirmUnrenewedRequest {
  readonly id: unknown;
  readonly requestId: unknown;
  readonly reason: unknown;
}

export type ConfirmUnrenewedCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type ConfirmUnrenewedAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      // false when the queue message was not sent: the scheduler sends it again (3.4).
      readonly sent: boolean;
    }
  | { readonly ok: false; readonly code: ConfirmUnrenewedCode };

type Outcome =
  | { ok: true; replayed: boolean; message: AdminMessage | null }
  | { ok: false; code: ConfirmUnrenewedCode };

export function makeConfirmUnrenewedAction(
  deps: OpsFlowDeps,
): (request: ConfirmUnrenewedRequest) => Promise<ConfirmUnrenewedAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const id = request.id;
    const requestId = request.requestId;
    const reason = request.reason;
    // 1 and 2. Authenticate and authorize.
    let actor;
    try {
      actor = await deps.authorize(RENEWAL_CONFIRM_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      const valid = check(confirmUnrenewedAction, { id, requestId, reason });
      if (valid === null) return { ok: false, code: "invalid" };
      const at = deps.clock.now();
      // 4. Rate limit.
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run<Outcome>(actor, async (repos) => {
        const written = await repos.operations.confirmUnrenewed(
          { operationId: valid.id, requestId: valid.requestId, at },
          valid.reason,
        );
        if (!written.ok) {
          const error = written.error;
          return {
            ok: false,
            code:
              error === "forbidden"
                ? "denied"
                : error === "validation"
                  ? "invalid"
                  : error === "not_found" || error === "conflict"
                    ? error
                    : "unavailable",
          };
        }
        return { ok: true, replayed: written.replayed, message: written.value.message };
      });
      if (!outcome.ok) return { ok: false, code: outcome.code };
      // After the commit: a lost send is found again by the scheduler, so it is not an error.
      const sent =
        outcome.message === null ? true : await sendAfterCommit(deps.queue, outcome.message);
      return { ok: true, replayed: outcome.replayed, targetId: valid.id, sent };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
