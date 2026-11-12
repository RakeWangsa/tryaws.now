import { sendAfterCommit, type OperationQueue } from "@tc/core";
import { ABUSE_SOURCES, type AbuseSource, type AdminActor, type AdminRole } from "@tc/db";
import {
  cleanReason,
  cleanText,
  cleanUuid,
  failureCode,
  type CaseActionAnswer,
  type CaseFlowDeps,
} from "./case-flow-common.ts";

// The actions of /abuse (16.12) in the order of R9: authorize, validate, rate limit, execute (one
// transaction, every write through `audited`), answer. ops, support and superadmin work cases;
// suspendResource and restoreResource (WPU-B5, lifts an admin suspension) are for ops and superadmin. It writes an operation row only (R1); the queue message
// goes out after the commit and a lost send is found again by the scheduler (3.4).

export type AbuseActionKind =
  "openAbuseCase" | "addNote" | "closeAbuseCase" | "suspendResource" | "restoreResource";
export const ABUSE_ACTION_KINDS: readonly AbuseActionKind[] = [
  "openAbuseCase",
  "addNote",
  "closeAbuseCase",
  "suspendResource",
  "restoreResource",
];
export const ABUSE_ROLES: readonly AdminRole[] = ["ops", "support", "superadmin"];
export const SUSPEND_ROLES: readonly AdminRole[] = ["ops", "superadmin"];
export const MAX_NOTES = 2000;
export const MAX_NOTE_LINE = 1000;

export interface AbuseActionRequest {
  readonly kind: AbuseActionKind;
  // The case id for every kind. openAbuseCase takes it from the form (the idempotency key of the case).
  readonly id: unknown;
  readonly reason: unknown;
  readonly resourceId?: unknown;
  readonly source?: unknown;
  readonly notes?: unknown;
  readonly noteId?: unknown;
  readonly note?: unknown;
}

export interface AbuseFlowDeps extends CaseFlowDeps {
  readonly queue: OperationQueue;
}

export function makeAbuseAction(
  deps: AbuseFlowDeps,
): (request: AbuseActionRequest) => Promise<CaseActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { kind, id, reason, resourceId, source, notes, noteId, note } = request;
    // 1 and 2. Authenticate and authorize (a bad kind is asked as the wider role list and refused below).
    let actor: AdminActor;
    try {
      actor = await deps.authorize(
        kind === "suspendResource" || kind === "restoreResource" ? SUSPEND_ROLES : ABUSE_ROLES,
      );
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      if (typeof kind !== "string" || !ABUSE_ACTION_KINDS.includes(kind)) {
        return { ok: false, code: "invalid" };
      }
      const caseId = cleanUuid(id);
      const why = cleanReason(reason);
      if (caseId === null || why === null) return { ok: false, code: "invalid" };
      let open: { resourceId: string; source: AbuseSource; notes?: string } | null = null;
      let line: { noteId: string; note: string } | null = null;
      if (kind === "openAbuseCase") {
        const res = cleanUuid(resourceId);
        const src = typeof source === "string" ? source : "";
        const extra =
          notes === undefined || notes === null || notes === ""
            ? undefined
            : cleanText(notes, MAX_NOTES);
        if (res === null || !(ABUSE_SOURCES as readonly string[]).includes(src) || extra === null) {
          return { ok: false, code: "invalid" };
        }
        open = {
          resourceId: res,
          source: src as AbuseSource,
          ...(extra === undefined ? {} : { notes: extra }),
        };
      }
      if (kind === "addNote") {
        const nid = cleanUuid(noteId);
        const text = cleanText(note, MAX_NOTE_LINE);
        if (nid === null || text === null) return { ok: false, code: "invalid" };
        line = { noteId: nid, note: text };
      }
      const at = deps.clock.now();
      // 4. Rate limit.
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run(actor, async (repos) => {
        switch (kind) {
          case "openAbuseCase":
            return { written: await repos.abuse.open({ caseId, ...open! }, why), message: null };
          case "addNote":
            return {
              written: await repos.abuse.addNote({ caseId, ...line!, at }, why),
              message: null,
            };
          case "closeAbuseCase":
            return { written: await repos.abuse.close({ caseId, at }, why), message: null };
          case "restoreResource": {
            const written = await repos.abuse.restoreResource({ caseId, at }, why);
            return { written, message: written.ok ? written.value.message : null };
          }
          case "suspendResource": {
            const written = await repos.abuse.suspendResource({ caseId, at }, why);
            return { written, message: written.ok ? written.value.message : null };
          }
        }
      });
      if (!outcome.written.ok) return { ok: false, code: failureCode(outcome.written) };
      // After the commit: a lost send is found again by the scheduler, so it is not an error.
      const sent =
        outcome.message === null ? true : await sendAfterCommit(deps.queue, outcome.message);
      return { ok: true, replayed: outcome.written.replayed, targetId: caseId, sent };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
