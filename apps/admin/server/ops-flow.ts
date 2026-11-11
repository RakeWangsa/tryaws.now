import { sendAfterCommit, type OperationQueue } from "@tc/core";
import type { AdminActor, AdminMessage, AdminRepos, AdminRole } from "@tc/db";
import { judge, OPS_ACTION_KINDS, type OpsActionKind } from "./ops-map.ts";

// The decisions of /operations in the order of R9: authenticate and authorize, validate, rate limit,
// execute (one transaction; every write through `audited`, which appends the audit row with actor,
// reason, IP and target), and the answer. The approver is the admin of the verified session: the
// request has no field for one, so a form cannot name an approver. No next/* import: the Server Action
// wires the real pieces and every step is tested with fakes. Answers are fixed codes, never the text of
// an error (R14, R16).

export interface OpsActionRequest {
  readonly kind: OpsActionKind;
  readonly id: unknown;
  readonly reason: unknown;
}

export type OpsActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type OpsActionAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      // false when the queue message was not sent: the scheduler sends it again (3.4).
      readonly sent: boolean;
    }
  | { readonly ok: false; readonly code: OpsActionCode };

export interface OpsFlowDeps {
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly queue: OperationQueue;
  readonly clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_REASON = 500;

// 16.12: ops decides; superadmin owns every area.
export const OPS_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

type Outcome =
  | { ok: true; replayed: boolean; message: AdminMessage | null }
  | { ok: false; code: "not_found" | "conflict" | "invalid" | "denied" };

export function makeOpsAction(
  deps: OpsFlowDeps,
): (request: OpsActionRequest) => Promise<OpsActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const kind = request.kind;
    const id = request.id;
    const reason = request.reason;
    // 1 and 2. Authenticate and authorize.
    let actor: AdminActor;
    try {
      actor = await deps.authorize(OPS_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      if (typeof kind !== "string" || !(OPS_ACTION_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, code: "invalid" };
      }
      if (typeof id !== "string" || !UUID.test(id)) return { ok: false, code: "invalid" };
      if (typeof reason !== "string") return { ok: false, code: "invalid" };
      const why = reason.trim();
      if (why === "" || why.length > MAX_REASON) return { ok: false, code: "invalid" };
      const operationId = id.toLowerCase();
      const at = deps.clock.now();
      // 4. Rate limit.
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run<Outcome>(actor, async (repos) => {
        const found = await repos.operations.detail(operationId);
        if (!found.ok) {
          return { ok: false, code: found.error === "not_found" ? "not_found" : "denied" };
        }
        // Only a move of ADMIN_TRANSITIONS (or its replay) reaches the repository (R16).
        const verdict = judge(kind, found.value);
        if (verdict === "refuse") return { ok: false, code: "conflict" };
        const input = { operationId, at };
        const written =
          kind === "approveOperation"
            ? await repos.operations.approve(input, why)
            : kind === "rejectOperation"
              ? await repos.operations.reject(input, why)
              : await repos.operations.retry(input, why);
        if (!written.ok) {
          const error = written.error;
          return {
            ok: false,
            code: error === "forbidden" ? "denied" : error === "validation" ? "invalid" : error,
          };
        }
        return { ok: true, replayed: written.replayed, message: written.value.message };
      });
      if (!outcome.ok) return { ok: false, code: outcome.code };
      // After the commit: a lost send is found again by the scheduler, so it is not an error.
      const sent =
        outcome.message === null ? true : await sendAfterCommit(deps.queue, outcome.message);
      return { ok: true, replayed: outcome.replayed, targetId: operationId, sent };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
