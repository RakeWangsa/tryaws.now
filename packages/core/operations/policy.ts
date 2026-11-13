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
  /**
   * Whether AWS may already have acted on the call that failed (AwsError.mayHaveActed: a time-out, a reset
   * connection or a 5xx after the request was sent). Not given means not known, which counts as true (R16).
   */
  readonly mayHaveActed?: boolean;
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

// WPU-Z13: the steps of a `renew_domain` (packages/aws/adapters/domain.ts renewAction; the contract is pinned in
// packages/aws/test/domain-actions.test.ts). At step null the adapter only reads (the payload, GetDomainDetail) and
// moves to `submit` in a write of its own; RenewDomain is called only at `submit`, and once it was accepted the
// adapter moves to `poll` in the same record as the registry's operation id. So a renewal at step null has sent
// nothing to the registry; from `submit` on the registry may hold a renewal that TiCON pays for and that may
// still complete, however long the registry takes (review round 2: a RenewDomain that timed out after it was sent
// is still at `submit`, not at `poll`).
const RENEWAL_SUBMIT_STEP = "submit";

/**
 * Whether the registry may hold the renewal of this operation: a `renew_domain` at any step but null (`submit`,
 * `poll`, or a step that is not known, R16). Such a renewal gives no money back on a final error unless the failure
 * proves that nothing reached the registry or the registry itself reported it failed (decideFailure), and an
 * admin's rejection of it is refused (reject.ts, `renewal_submitted`): a refund waits for the registry's answer.
 */
export function registryHoldsRenewal(kind: string, step: string | null): boolean {
  return kind === "renew_domain" && step !== null;
}

// WPU-Y5 (c): the step of a dns_zone create that sends CreateHostedZone (packages/aws/adapters/dns-zone.ts). Once
// it answered, the operation moves to `wait_insync` with the zone id saved: the hosted zone exists (and is billed).
const DNS_ZONE_CREATE_STEP = "create_zone";

/**
 * Whether the hosted zone of a `dns_zone` create may exist: any step past `create_zone` (`wait_insync`, or a step
 * that is not known, R16). An admin's rejection of such a create is refused (reject.ts, `zone_created`): the failed
 * hook would refund the order while the zone stays. The runbook says retry it, or destroy the zone first.
 */
export function dnsZoneMayExist(family: string, kind: string, step: string | null): boolean {
  return (
    family === "dns_zone" && kind === "create" && step !== null && step !== DNS_ZONE_CREATE_STEP
  );
}

// The registry's own answer that a renewal failed (GetOperationDetail FAILED or ERROR): the domain adapter throws
// `conflict` with no AWS error name. An AWS error of a read at that step carries its name (domains-client.ts) and
// says nothing about the renewal itself.
function registryRefused(facts: FailureFacts): boolean {
  return facts.code === "conflict" && facts.awsErrorName === null;
}

// At `submit`: the failure proves that this run sent nothing the registry may act on (AwsError.mayHaveActed false:
// a refusal of RenewDomain itself such as TLDRulesViolation, a request that never left the machine, or a local
// check), and no earlier run at this step can have sent one. The adapter enters the step with attempts 0 and
// last_error null (its own write, step.ts updateFor), and every run at the step that does not leave it records a
// failure (a retryable error, a refusal, a lost lease through the sweeper) that an admin's retry keeps. So a
// RenewDomain that may have reached the registry in an earlier run always leaves attempts above 0 or a last_error.
function provedNotSent(previous: Previous, facts: FailureFacts): boolean {
  return previous.attempts === 0 && previous.lastError === null && facts.mayHaveActed === false;
}

interface Previous {
  readonly attempts: number;
  /** undefined: not known, which proves nothing (R16). */
  readonly lastError: string | null | undefined;
}

// Whether a final error (not retryable, no full pool) ends the operation `failed`, with the refund of its hook.
function endsFailed(
  kind: string,
  step: string | null | undefined,
  previous: Previous,
  facts: FailureFacts,
): boolean {
  if (!refundedOnFailure(kind)) return false;
  if (kind !== "renew_domain" || step === null) return true;
  if (step === RENEWAL_SUBMIT_STEP) return provedNotSent(previous, facts);
  // At `poll`, and at a step that is not known (R16): only the registry's own refusal. A poll that gave up after
  // three days, a lost operation id or a bad answer stops in needs_attention, no money moved.
  return registryRefused(facts);
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
   * registry may hold the renewal; not given means not known, which counts as held (R16).
   */
  step?: string | null;
  attempts: number;
  /**
   * The operation's last_error before this run. Only a domain renewal at `submit` reads it (with `attempts`), to
   * know that no earlier run at the step can have sent RenewDomain; not given proves nothing (R16).
   */
  lastError?: string | null;
  now: Date;
  facts: FailureFacts;
}): FailureDecision {
  const { kind, step, attempts, now, facts } = input;
  const lastError = lastErrorText(facts);
  const failures = attempts + 1;
  if (facts.poolFull) return { to: "needs_attention", attempts: failures, lastError };
  if (!facts.retryable) {
    return {
      to: endsFailed(kind, step, { attempts, lastError: input.lastError }, facts)
        ? "failed"
        : "needs_attention",
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
