import type { OperationKind } from "@tc/db";
import type { ErrorCode } from "../types";
import type { LocalFailure } from "./types";

// Section 10.1: five failed attempts, then an admin decides.
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = Object.freeze([60, 120, 240, 480] as const);
export const LEASE_SECONDS = 120;
/**
 * WPU-X23. A create refused by AWS at its first step (code `validation`, AwsError.mayHaveActed false) fails after this
 * many failures: one retry. See `refusedAtFirstStep`.
 */
export const REPEATED_REFUSAL_ATTEMPTS = 2;
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
  /**
   * WPU-Y2 fix round 1. What the domain adapter learned of a renewal at `poll` (AwsError.reason): `failed` is the
   * registry's FAILED answer for the exact RenewDomain operation (final "not renewed"); `unrenewed` is an ERROR answer
   * or a poll that gave up, with a fresh GetDomainDetail showing the expiry unchanged. Not given: nothing learned.
   */
  readonly registryVerdict?: "failed" | "unrenewed";
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
// the renewal only when nothing can have reached the registry (below, WPU-Y2). Every other kind stops in needs_attention for an
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
const RENEWAL_POLL_STEP = "poll";

/**
 * Whether the registry may hold the renewal of this operation: a `renew_domain` at any step but null (`submit`,
 * `poll`, or a step that is not known, R16). Such a renewal gives no money back on a final error unless the failure
 * proves that nothing reached the registry (decideFailure; WPU-Y2: the registry's own refusal is no longer enough),
 * and an admin's rejection of it is refused (reject.ts, `renewal_submitted`).
 */
export function registryHoldsRenewal(kind: string, step: string | null): boolean {
  return kind === "renew_domain" && step !== null;
}

// WPU-Y5 (c): the step of a dns_zone create that sends CreateHostedZone (packages/aws/adapters/dns-zone.ts). Step null
// only moves there, with no AWS call, so a create at null has sent nothing. Once CreateHostedZone answered, the
// operation moves to `wait_insync` with the zone id saved: the hosted zone exists (and is billed).
const DNS_ZONE_CREATE_STEP = "create_zone";
// The last_error of createHostedZone's own input check (route53-client.ts validation(): code validation, no AWS
// error name). The input (zone name, caller reference = operation id, generated comment) is the same at every
// attempt, so that error proves no attempt ever sent CreateHostedZone.
const LOCAL_INPUT_REFUSAL = "validation";

/**
 * Whether the hosted zone of a `dns_zone` create may exist (fix round 1 of WPU-Y5, the renewal design of
 * registryHoldsRenewal and provedNotSent): at `create_zone` once an attempt may have sent CreateHostedZone (attempts
 * above 0 or a last_error, unless that error is the local input check), and at any step past it (`wait_insync`, or a
 * step that is not known, R16). An admin's rejection of such a create is refused (reject.ts, `zone_created`): the
 * failed hook would refund the order while the zone stays. The runbook says retry it, or destroy the zone first.
 */
export function dnsZoneMayExist(
  family: string,
  kind: string,
  step: string | null,
  previous: { readonly attempts: number; readonly lastError: string | null | undefined },
): boolean {
  if (family !== "dns_zone" || kind !== "create" || step === null) return false;
  if (step !== DNS_ZONE_CREATE_STEP) return true;
  if (previous.lastError === LOCAL_INPUT_REFUSAL) return false;
  return !(previous.attempts === 0 && previous.lastError === null);
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
  // At `poll` RenewDomain reached the registry. WPU-Y2 fix round 1 (coordinator ruling for the owner, 2026-11-14):
  // only the registry's FAILED answer for the exact saved RenewDomain operation (the adapter's `registry_failed`) is
  // final "not renewed" and ends it failed with the refund. ERROR, a poll that gave up, a lost operation id or a bad
  // answer stop in needs_attention, no money moved; an admin may reject the `registry_unrenewed` one (reject.ts).
  // At a step that is not known (R16): nothing ends it failed.
  return (
    step === RENEWAL_POLL_STEP && facts.code === "conflict" && facts.registryVerdict === "failed"
  );
}

/**
 * WPU-X23. Lightsail reports many problems as InvalidInputException, so the table keeps that name retryable. But a
 * `create` still at its FIRST step (step null: nothing was recorded as done) whose call AWS rejected
 * (`mayHaveActed === false`, not a time-out or a 5xx) has made nothing, and it sends the same input every time; five
 * tries and an admin only keep the customer's money held for about 15 minutes and then for days. Such a create fails
 * after one retry and its hook returns the money (10.1). An unknown step or an unknown `mayHaveActed` never counts (R16).
 */
function refusedAtFirstStep(
  kind: string,
  step: string | null | undefined,
  failures: number,
  facts: FailureFacts,
): boolean {
  return (
    kind === "create" &&
    step === null &&
    facts.code === "validation" &&
    facts.mayHaveActed === false &&
    failures >= REPEATED_REFUSAL_ATTEMPTS
  );
}

// No AWS text ever reaches last_error (R14): a code, and a plain error name when there is one. WPU-Y2 fix round 1:
// without an AWS error name, the registry verdict of a renewal (`registry_failed`, `registry_unrenewed`).
export function lastErrorText(facts: FailureFacts): string {
  const name = facts.awsErrorName;
  if (name !== null && PLAIN_ERROR_NAME.test(name)) return `${facts.code}:${name}`;
  return facts.registryVerdict === undefined
    ? facts.code
    : `${facts.code}:registry_${facts.registryVerdict}`;
}

/**
 * WPU-Y2 fix round 2. The last_error of a renewal whose registry answered ERROR (final, not SUCCESSFUL) and whose
 * fresh GetDomainDetail showed the pre-renewal expiry to the millisecond, with the time the provisioner recorded that
 * check (`checkedAt`, epoch seconds): `upstream_unavailable:registry_unrenewed:<seconds>`. A digit count of 10 only.
 */
const REGISTRY_UNRENEWED_PREFIX = "upstream_unavailable:registry_unrenewed:";
const REGISTRY_UNRENEWED = /^upstream_unavailable:registry_unrenewed:(\d{10})$/;

export function registryUnrenewedError(checkedAt: Date): string {
  return `${REGISTRY_UNRENEWED_PREFIX}${Math.floor(checkedAt.getTime() / 1000)}`;
}

/** The check time of such a last_error; null for any other text. */
export function registryCheckedAt(lastError: string | null): Date | null {
  const found = lastError === null ? null : REGISTRY_UNRENEWED.exec(lastError);
  return found === null ? null : new Date(Number(found[1]) * 1000);
}

/** WPU-Y2 fix round 1: how old the registry check of a renewal may be when an admin rejects it with its refund. */
export const REGISTRY_CHECK_FRESH_MS = 60 * 60 * 1000;

/**
 * WPU-Y2 fix round 1 (the safe minimum of the coordinator's ruling 2), round 2 (an explicit check time). Whether an
 * admin's rejection of a stuck operation may move it to failed, with the refund of its hook. Every kind but a domain
 * renewal the registry may hold: yes. A domain renewal at `poll`: only when its last run recorded the provisioner's
 * check (registryUnrenewedError: ERROR for the saved operation and the expiry unchanged to the millisecond) and that
 * check is at most REGISTRY_CHECK_FRESH_MS old (and not more than 5 minutes ahead of this clock). The check lives in
 * last_error, so it is gone as soon as the operation runs again: a retry, a move to another step (which writes
 * last_error null) or any other failure (which writes its own) clears it; a rejection needs the state
 * needs_attention, which only a run that ended again reaches. A poll that gave up while the operation was still in
 * progress records a plain error: never a refund. At `submit` (an answer may be lost): never.
 */
export function rejectionAllowed(
  target: {
    readonly kind: string;
    readonly step: string | null;
    readonly lastError: string | null;
  },
  now: Date,
): boolean {
  if (!registryHoldsRenewal(target.kind, target.step)) return true;
  if (target.step !== RENEWAL_POLL_STEP) return false;
  const checkedAt = registryCheckedAt(target.lastError);
  if (checkedAt === null) return false;
  const age = now.getTime() - checkedAt.getTime();
  // A time that cannot be read is not fresh (R16).
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= REGISTRY_CHECK_FRESH_MS;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

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
  // WPU-Y2 fix round 2: the registry check of a renewal at poll carries the time the provisioner recorded it.
  const lastError =
    facts.registryVerdict === "unrenewed" &&
    step === RENEWAL_POLL_STEP &&
    facts.awsErrorName === null
      ? registryUnrenewedError(now)
      : lastErrorText(facts);
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
  if (refusedAtFirstStep(kind, step, failures, facts)) {
    return { to: "failed", attempts: failures, lastError };
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
