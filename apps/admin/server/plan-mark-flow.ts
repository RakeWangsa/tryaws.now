import { sendAfterCommit } from "@tc/core";
import type { AdminMessage } from "@tc/db";
import { MAX_REASON, OPS_ROLES, type OpsFlowDeps } from "./ops-flow.ts";

// WPA-P2. The admin action that clears the failure mark of a plan change (container service, CDN), in
// the order of R9: authenticate and authorize, validate, rate limit, execute (one transaction; the write
// goes through `audited`, which stores actor, reason, IP and target), and the answer. The action queues
// an operation (`clear_plan_change_mark`) that the provisioner applies to the config: the admin never
// writes the resource row, calls no AWS and posts no ledger line. The request has no field for an actor
// or a role. Answers are fixed codes, never the text of an error (R14, R16).

export interface PlanMarkRequest {
  readonly resourceId: unknown;
  readonly requestId: unknown;
  readonly reason: unknown;
}

export type PlanMarkCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type PlanMarkAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      // false when the queue message was not sent: the scheduler sends it again (3.4).
      readonly sent: boolean;
    }
  | { readonly ok: false; readonly code: PlanMarkCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome =
  { ok: true; replayed: boolean; message: AdminMessage | null } | { ok: false; code: PlanMarkCode };

export function makePlanMarkAction(
  deps: OpsFlowDeps,
): (request: PlanMarkRequest) => Promise<PlanMarkAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const resourceId = request.resourceId;
    const requestId = request.requestId;
    const reason = request.reason;
    // 1 and 2. Authenticate and authorize.
    let actor;
    try {
      actor = await deps.authorize(OPS_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      if (typeof resourceId !== "string" || !UUID.test(resourceId)) {
        return { ok: false, code: "invalid" };
      }
      if (typeof requestId !== "string" || !UUID.test(requestId)) {
        return { ok: false, code: "invalid" };
      }
      if (typeof reason !== "string") return { ok: false, code: "invalid" };
      const why = reason.trim();
      if (why === "" || why.length > MAX_REASON) return { ok: false, code: "invalid" };
      const at = deps.clock.now();
      // 4. Rate limit.
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run<Outcome>(actor, async (repos) => {
        const written = await repos.operations.clearPlanChangeMark(
          { resourceId: resourceId.toLowerCase(), requestId: requestId.toLowerCase(), at },
          why,
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
      return { ok: true, replayed: outcome.replayed, targetId: resourceId.toLowerCase(), sent };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
