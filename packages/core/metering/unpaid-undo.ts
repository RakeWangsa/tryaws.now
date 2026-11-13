import type { ResourceOpRow } from "@tc/db";

// WPU-Y3c. Pure rules for what the unpaid job may undo when the customer has paid. No database, no
// clock. The security review found two gaps:
//   1. a blind `resume` could lift a suspension that somebody else made (an admin's abuse suspend, a
//      lifecycle suspend) or race with a suspend of the job itself that had not run yet;
//   2. the final snapshots were released and deleted without looking at the retention destroy (R13).

/** The states of an operation that is not over yet. */
const IN_FLIGHT = new Set(["queued", "running", "waiting", "needs_approval", "needs_attention"]);

/** Every suspend the unpaid job makes has this prefix (all episodes of the resource). */
export const unpaidSuspendPrefix = (resourceId: string): string => `unpaid:suspend:${resourceId}:`;

const isOwnSuspend = (op: ResourceOpRow, resourceId: string): boolean =>
  op.kind === "suspend" && op.key.startsWith(unpaidSuspendPrefix(resourceId));

// The suspend of a grace period (`lifecycle:suspend:<subscription>:<period end>`). Once it has run, the
// subscription itself says whether it is over (the caller requires an active subscription with a
// period end in the future).
const isLifecycleSuspend = (op: ResourceOpRow): boolean =>
  op.kind === "suspend" && op.key.startsWith("lifecycle:suspend:");

export interface SuspendView {
  /** The job's own suspends that have not started: they are cancelled, not resumed. */
  readonly cancellable: readonly ResourceOpRow[];
  /** The job's own suspends that started or ran (not failed, not cancellable): a resume must follow. */
  readonly ownInFlightOrDone: boolean;
  /** Another suspend (admin, lifecycle, unknown) is still open, or done and not resumed. */
  readonly foreignHolds: boolean;
}

/**
 * Sorts the suspend and resume operations of a resource. A foreign suspend holds the resource when it
 * is open (queued, running, waiting, waiting for approval or attention), and, once it has run, when it
 * is not a lifecycle suspend and no `resume` that succeeded was created after it (an admin's or an
 * unknown suspension is only lifted by its own resume, R16). A failed suspend holds nothing.
 */
export function viewSuspends(ops: readonly ResourceOpRow[], resourceId: string): SuspendView {
  const resumes = ops.filter((o) => o.kind === "resume" && o.state === "succeeded");
  const cancellable: ResourceOpRow[] = [];
  let ownInFlightOrDone = false;
  let foreignHolds = false;
  for (const op of ops) {
    if (op.kind !== "suspend") continue;
    if (isOwnSuspend(op, resourceId)) {
      if (op.state === "queued") cancellable.push(op);
      else if (op.state !== "failed") ownInFlightOrDone = true;
      continue;
    }
    if (op.state === "failed") continue;
    if (IN_FLIGHT.has(op.state)) {
      foreignHolds = true;
    } else if (op.state === "succeeded" && !isLifecycleSuspend(op)) {
      if (!resumes.some((r) => r.createdAtMs > op.createdAtMs)) foreignHolds = true;
    } else if (op.state !== "succeeded") {
      foreignHolds = true; // a state we do not know: fail closed
    }
  }
  return { cancellable, ownInFlightOrDone, foreignHolds };
}

export type DestroyView =
  /** Nothing ran or is approved; these are the destroys to cancel before the flag is cleared. */
  | { readonly safe: true; readonly toCancel: readonly ResourceOpRow[] }
  /** A destroy is running, done, approved, stuck or failed after it ran: the final snapshot stays. */
  | { readonly safe: false };

/**
 * R13. May the final snapshots of a resource be released? Only when every destroy operation of the
 * resource (the plain key and the episode-salted key alike: the kind is what counts) never ran and was
 * not approved. `failed` with no attempt is a destroy that was cancelled or rejected before it ran.
 * A destroy that is queued or waiting for approval (nobody approved) is returned to be cancelled; the
 * caller must see every cancel succeed before it goes on.
 */
export function viewDestroys(ops: readonly ResourceOpRow[]): DestroyView {
  const toCancel: ResourceOpRow[] = [];
  for (const op of ops) {
    if (op.kind !== "destroy") continue;
    if (op.approved) return { safe: false };
    if (op.state === "failed") {
      if (op.attempts > 0) return { safe: false };
      continue;
    }
    if ((op.state === "queued" || op.state === "needs_approval") && op.attempts === 0) {
      toCancel.push(op);
      continue;
    }
    return { safe: false };
  }
  return { safe: true, toCancel };
}
