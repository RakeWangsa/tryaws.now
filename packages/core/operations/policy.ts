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

// No AWS text ever reaches last_error (R14): a code, and a plain error name when there is one.
export function lastErrorText(facts: FailureFacts): string {
  const name = facts.awsErrorName;
  return name !== null && PLAIN_ERROR_NAME.test(name) ? `${facts.code}:${name}` : facts.code;
}

// `attempts` is the count before this failure.
export function decideFailure(input: {
  kind: OperationKind;
  attempts: number;
  now: Date;
  facts: FailureFacts;
}): FailureDecision {
  const { kind, attempts, now, facts } = input;
  const lastError = lastErrorText(facts);
  const failures = attempts + 1;
  if (facts.poolFull) return { to: "needs_attention", attempts: failures, lastError };
  if (!facts.retryable) {
    return { to: kind === "create" ? "failed" : "needs_attention", attempts: failures, lastError };
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
