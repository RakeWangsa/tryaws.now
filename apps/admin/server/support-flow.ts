import type { AdminActor, AdminRole } from "@tc/db";
import {
  cleanReason,
  cleanText,
  cleanUuid,
  failureCode,
  type CaseActionAnswer,
  type CaseFlowDeps,
} from "./case-flow-common.ts";

// The two actions of /support (16.12) in the order of R9: authorize, validate, rate limit, execute (one
// transaction, every write through `audited`), answer. The roles are support and superadmin. The admin
// of the answer is the one of the verified session: the request has no field for one.

export type SupportActionKind = "replyByEmail" | "closeRequest";
export const SUPPORT_ACTION_KINDS: readonly SupportActionKind[] = ["replyByEmail", "closeRequest"];
export const SUPPORT_ROLES: readonly AdminRole[] = ["support", "superadmin"];
export const MAX_REPLY = 5000;
// R10 wants a reason on every action; a reply states it itself and the text goes to the customer only.
export const REPLY_REASON = "reply to support request";

export interface SupportActionRequest {
  readonly kind: SupportActionKind;
  readonly id: unknown;
  readonly reason?: unknown;
  readonly replyId?: unknown;
  readonly body?: unknown;
}

export interface SupportFlowDeps extends CaseFlowDeps {
  // False while no email template for the reply exists in the notifier: the action then refuses
  // before anything is written (R16), so no request is marked answered without a message.
  readonly replyEnabled: boolean;
}

export function makeSupportAction(
  deps: SupportFlowDeps,
): (request: SupportActionRequest) => Promise<CaseActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { kind, id, reason, replyId, body } = request;
    // 1 and 2. Authenticate and authorize.
    let actor: AdminActor;
    try {
      actor = await deps.authorize(SUPPORT_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      if (typeof kind !== "string" || !SUPPORT_ACTION_KINDS.includes(kind)) {
        return { ok: false, code: "invalid" };
      }
      const requestId = cleanUuid(id);
      if (requestId === null) return { ok: false, code: "invalid" };
      const why = kind === "replyByEmail" ? REPLY_REASON : cleanReason(reason);
      if (why === null) return { ok: false, code: "invalid" };
      const rid = kind === "replyByEmail" ? cleanUuid(replyId) : "";
      const text = kind === "replyByEmail" ? cleanText(body, MAX_REPLY) : "";
      if (rid === null || text === null) return { ok: false, code: "invalid" };
      if (kind === "replyByEmail" && !deps.replyEnabled) return { ok: false, code: "unavailable" };
      // 4. Rate limit.
      if (!(await deps.limiter(actor, deps.clock.now())))
        return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const written = await deps.run(actor, (repos) =>
        kind === "replyByEmail"
          ? repos.support.reply({ requestId, replyId: rid, body: text }, why)
          : repos.support.close({ requestId }, why),
      );
      if (!written.ok) return { ok: false, code: failureCode(written) };
      return { ok: true, replayed: written.replayed, targetId: requestId, sent: true };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
