import type { OperationKind } from "@tc/db";
import type { ErrorCode } from "../types";
import type { LocalFailure } from "./types";

// Section 10.1: five failed attempts, then an admin decides.
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = Object.freeze([60, 120, 240, 480] as const);
export const LEASE_SECONDS = 120;
export const STALE_QUEUED_SECONDS = 120;

// The runner builds this from an AwsError; packages/core does not import @tc/aws.
export interface FailureFacts {
  readonly code: ErrorCode | LocalFailure;
  readonly retryable: boolean;
  readonly poolFull: boolean;
  readonly awsErrorName: string | null;
}

export type FailureDecision =
  | {
      readonly to: "waiting";
      readonly attempts: number;
      readonly nextRunAt: Date;
      readonly lastError: string;
    }
  | { readonly to: "needs_attention"; readonly attempts: number; readonly lastError: string }
  | { readonly to: "failed"; readonly attempts: number; readonly lastError: string };

const PLAIN_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

// 10.1: an error that can never succeed on a retry ends these kinds in `failed`, where the failed hook gives the
// money back in the same transaction: a create its order (WP4-T4), a domain renewal its renewal charge (WPU-Z13),
// the renewal only while the registry does not hold it (below). Every other kind stops in needs_attention for an
// admin. An admin's rejection runs the same hook (reject.ts).
const REFUNDED_KINDS: readonly string[] = Object.freeze(["create", "renew_domain"]);

/** Whether a failure of the kind is final and moves money back (the failed hook must be installed, R16). */
export function refundedOnFailure(kind: string): kind is "create" | "renew_domain" {
  return REFUNDED_KINDS.includes(kind);
}

// WPU-Z13 (review round 1): the step of a `renew_domain` after RenewDomain was accepted. The domain adapter moves
// there in the same record as the registry's operation id (packages/aws/adapters/domain.ts renewAction; the
// contract is pinned in packages/aws/test/domain-actions.test.ts). From here on the registry holds a renewal that
// TiCON pays for and that may still complete, however long the registry takes.
const RENEWAL_HELD_STEP = "poll";

/**
 * Whether the registry holds the renewal of this operation: a `renew_domain` at the step after RenewDomain. Such a
 * renewal gives no money back on a final error unless the registry itself reported it failed (decideFailure), and
 * an admin's rejection of it is refused (reject.ts, `renewal_submitted`): a refund waits for the registry's answer.
 */
export function registryHoldsRenewal(kind: string, step: string | null): boolean {
  return kind === "renew_domain" && step === RENEWAL_HELD_STEP;
}

// The registry's own answer that a renewal failed (GetOperationDetail FAILED or ERROR): the domain adapter throws
// `conflict` with no AWS error name. An AWS error of a read at that step carries its name (domains-client.ts) and
// says nothing about the renewal itself.
function registryRefused(facts: FailureFacts): boolean {
  return facts.code === "conflict" && facts.awsErrorName === null;
}

// Whether a final error (not retryable, no full pool) ends the operation `failed`, with the refund of its hook.
function endsFailed(kind: string, step: string | null | undefined, facts: FailureFacts): boolean {
  if (!refundedOnFailure(kind)) return false;
  // A renewal at a step that is not known is taken as held (R16): no refund without the registry's answer. A poll
  // that gave up after three days, a lost operation id or a bad answer stops in needs_attention, no money moved.
  if (kind === "renew_domain" && (step === undefined || registryHoldsRenewal(kind, step))) {
    return registryRefused(facts);
  }
  return true;
}

// No AWS text ever reaches last_error (R14): a code, and a plain error name when there is one.
export function lastErrorText(facts: FailureFacts): string {
  const name = facts.awsErrorName;
  return name !== null && PLAIN_ERROR_NAME.test(name) ? `${facts.code}:${name}` : facts.code;
}

// `attempts` is the count before this failure.
export function decideFailure(input: {
  kind: OperationKind;
  /**
   * The step the operation is at (null before its first one). Only a domain renewal reads it, to know whether the
   * registry holds the renewal; not given means not known, which counts as held (R16).
   */
  step?: string | null;
  attempts: number;
  now: Date;
  facts: FailureFacts;
}): FailureDecision {
  const { kind, step, attempts, now, facts } = input;
  const lastError = lastErrorText(facts);
  const failures = attempts + 1;
  if (facts.poolFull) return { to: "needs_attention", attempts: failures, lastError };
  if (!facts.retryable) {
    return {
      to: endsFailed(kind, step, facts) ? "failed" : "needs_attention",
      attempts: failures,
      lastError,
    };
  }
  if (failures >= MAX_ATTEMPTS) return { to: "needs_attention", attempts: failures, lastError };
  const delay: number | undefined = RETRY_DELAYS_SECONDS[attempts];
  // A negative, fractional or NaN count has no delay: refuse instead of guessing (R16).
  if (delay === undefined) return { to: "needs_attention", attempts: failures, lastError };
  return {
    to: "waiting",
    attempts: failures,
    nextRunAt: new Date(now.getTime() + delay * 1000),
    lastError,
  };
}

// A refusal of the engine itself: needs_attention, no attempt counted, the code as the reason.
export function decideRefusal(
  code: Exclude<LocalFailure, "lease_expired">,
  attempts: number,
): Extract<FailureDecision, { to: "needs_attention" }> {
  return { to: "needs_attention", attempts, lastError: code };
}
