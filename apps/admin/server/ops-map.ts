import { canTransition } from "@tc/core";
import type { OperationStateName } from "@tc/db";

// What the operations screens decide from the state alone. Nothing here reads a row or sends text.

// R14: last_error is a code written by the engine, sometimes followed by ":" and a plain error name.
// A page shows one of these fixed codes and never the stored text, so no AWS text can reach it.
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "kyc_required",
  "limit_reached",
  "flag_off",
  "validation",
  "insufficient_balance",
  "capacity_full",
  "price_changed",
  "conflict",
  "not_found",
  "rate_limited",
  "upstream_unavailable",
  "internal",
  "unknown_kind",
  "resource_missing",
  "resource_unplaced",
  "no_adapter",
  "invalid_config",
  "approval_flag_missing",
  "approval_missing",
  "destructive_guard_missing",
  "destructive_guard_refused",
  "owner_mismatch",
  "resource_state",
  "failed_hook_missing",
  "invalid_step_result",
  "lease_expired",
] as const;
export type ErrorCodeName = (typeof ERROR_CODES)[number] | "other";

export function mapLastError(lastError: string | null): ErrorCodeName | null {
  if (lastError === null || lastError === "") return null;
  const head = lastError.split(":", 1)[0] ?? "";
  return (ERROR_CODES as readonly string[]).includes(head) ? (head as ErrorCodeName) : "other";
}

export type OpsActionKind = "approveOperation" | "rejectOperation" | "retryOperation";
export const OPS_ACTION_KINDS: readonly OpsActionKind[] = [
  "approveOperation",
  "rejectOperation",
  "retryOperation",
];

// The state changes each action makes, as pairs of the table of 10.1. The repository writes exactly
// these (approve: A1, reject of a waiting approval: A2, retry: A3). A reject of a stuck operation is
// not a state change of an admin: it inserts a reject_operation that the provisioner runs, so the
// compensation of 10.1 is not skipped (an admin has no move from needs_attention to failed).
export const ACTION_TRANSITIONS: Readonly<
  Record<OpsActionKind, readonly (readonly [OperationStateName, OperationStateName])[]>
> = {
  approveOperation: [["needs_approval", "queued"]],
  rejectOperation: [["needs_approval", "failed"]],
  retryOperation: [["needs_attention", "queued"]],
};

// The state a finished action leaves behind: doing it again changes nothing (R7).
const REPLAY_STATE: Readonly<Record<OpsActionKind, readonly OperationStateName[]>> = {
  approveOperation: ["queued", "running", "waiting", "succeeded"],
  rejectOperation: ["failed"],
  retryOperation: ["queued"],
};

export interface OperationFacts {
  readonly state: OperationStateName;
  readonly kind: string;
  readonly approvedBy: string | null;
}

export type Verdict = "do" | "replay" | "refuse";

// The check before the write, from the stored state. "do": the move is in ADMIN_TRANSITIONS (or the
// engine reject of a stuck operation). "replay": it was done before. Everything else is refused and
// nothing is sent to the repository (R16). A paid create is never rejected here (open point 14).
export function judge(action: OpsActionKind, facts: OperationFacts): Verdict {
  if (action === "rejectOperation" && facts.kind === "create" && facts.state === "needs_approval") {
    return "refuse";
  }
  const moves = ACTION_TRANSITIONS[action];
  if (moves.some(([from, to]) => from === facts.state && canTransition("admin", from, to))) {
    return "do";
  }
  if (action === "rejectOperation" && facts.state === "needs_attention") return "do";
  if (action === "approveOperation" && facts.approvedBy === null) return "refuse";
  return REPLAY_STATE[action].includes(facts.state) ? "replay" : "refuse";
}

// The buttons of the detail page: the actions the stored state allows now.
export function actionsFor(facts: OperationFacts): OpsActionKind[] {
  return OPS_ACTION_KINDS.filter((action) => judge(action, facts) === "do");
}
