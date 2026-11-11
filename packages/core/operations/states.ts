import type { OperationState } from "@tc/db";
import type { OperationActor } from "./types";

export type OperationTransition = readonly [from: OperationState, to: OperationState];

// W1 to W11 of the state machine of 10.1, in that order.
export const WORKER_TRANSITIONS: readonly OperationTransition[] = Object.freeze([
  Object.freeze(["queued", "running"] as const),
  Object.freeze(["queued", "waiting"] as const),
  Object.freeze(["queued", "needs_attention"] as const),
  Object.freeze(["queued", "queued"] as const),
  Object.freeze(["waiting", "queued"] as const),
  Object.freeze(["running", "queued"] as const),
  Object.freeze(["running", "waiting"] as const),
  Object.freeze(["running", "succeeded"] as const),
  Object.freeze(["running", "failed"] as const),
  Object.freeze(["running", "needs_attention"] as const),
  Object.freeze(["needs_attention", "failed"] as const),
]);

// A1 to A3. needs_attention -> failed is the worker's move (W11): an admin doing it would skip the refund.
export const ADMIN_TRANSITIONS: readonly OperationTransition[] = Object.freeze([
  Object.freeze(["needs_approval", "queued"] as const),
  Object.freeze(["needs_approval", "failed"] as const),
  Object.freeze(["needs_attention", "queued"] as const),
]);

export const INSERT_STATES: {
  readonly web: readonly OperationState[];
  readonly worker: readonly OperationState[];
  readonly admin: readonly OperationState[];
} = Object.freeze({
  web: Object.freeze(["queued", "needs_approval"] as const),
  worker: Object.freeze(["queued", "needs_approval"] as const),
  admin: Object.freeze(["queued"] as const),
});

// The columns of an existing row that each role may update (grants.expected.json).
export const WRITABLE_COLUMNS: {
  readonly web: readonly string[];
  readonly worker: readonly string[];
  readonly admin: readonly string[];
} = Object.freeze({
  web: Object.freeze([] as const),
  worker: Object.freeze([
    "state",
    "step",
    "attempts",
    "enqueue_seq",
    "next_run_at",
    "last_error",
  ] as const),
  admin: Object.freeze(["state", "approved_by", "next_run_at", "enqueue_seq"] as const),
});

export function canTransition(
  actor: OperationActor,
  from: OperationState,
  to: OperationState,
): boolean {
  const table = actor === "worker" ? WORKER_TRANSITIONS : ADMIN_TRANSITIONS;
  return table.some(([f, t]) => f === from && t === to);
}

export function assertTransition(
  actor: OperationActor,
  from: OperationState,
  to: OperationState,
): void {
  if (!canTransition(actor, from, to)) {
    throw new Error(`operation: illegal transition ${from} -> ${to} by ${actor}`);
  }
}

export function isFinal(state: OperationState): boolean {
  return state === "succeeded" || state === "failed";
}
