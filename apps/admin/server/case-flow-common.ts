import type { AdminActor, AdminRepos, AdminRole } from "@tc/db";

// What the three case flows (support, abuse, reconciliation) share: the shape of an answer, the
// dependencies and the small validators. No next/* import: the Server Actions wire the real pieces and
// every step is tested with fakes. Answers are fixed codes, never the text of an error (R14, R16).

export type CaseActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type CaseActionAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      // false when a queue message was not sent: the scheduler sends it again (3.4). True when there
      // was nothing to send.
      readonly sent: boolean;
    }
  | { readonly ok: false; readonly code: CaseActionCode };

export interface CaseFlowDeps {
  // requireAdmin(roles): rejects when there is no admin session or the role is wrong.
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  // True when the hit was counted, false over the limit.
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  // One transaction as admin_rw with the repositories of the actor.
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_REASON = 500;

export function cleanReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const text = reason.trim();
  return text === "" || text.length > MAX_REASON ? null : text;
}

export function cleanUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text.length > max ? null : text;
}

type RepoFailure = { ok: false; error: "not_found" | "conflict" | "validation" | "forbidden" };

export function failureCode(outcome: RepoFailure): CaseActionCode {
  if (outcome.error === "forbidden") return "denied";
  if (outcome.error === "validation") return "invalid";
  return outcome.error;
}
