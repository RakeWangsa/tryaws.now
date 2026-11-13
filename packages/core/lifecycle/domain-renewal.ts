import {
  findLedgerTransactionByKey,
  findReversalOf,
  insertOperation,
  lifecycleRepo,
  patchResource,
  type LifecycleRow,
  type OperationInput,
  type SubscriptionStatus,
  type Tx,
} from "@tc/db";
import { DOMAIN_YEARS } from "../domains/resolve";
import { lockWallet } from "../ledger/balance";
import { MAX_RENEWAL_ATTEMPT, ledgerKey } from "../ledger/keys";
import { isUuid } from "../validation/uuid";
import { reverseTransaction } from "../ledger/reverse";
import { firstMessage, type QueueMessage } from "../operations/queue";
import type { Logger } from "../operations/types";
import type { NoticeWriter } from "./notice";
import type { Result } from "../types";

// WPU-Z13. A domain's renewal charge (the lifecycle at the period end, or renewNow) pays for a renewal at the
// registry: in the transaction of the charge one `renew_domain` operation is queued for the period (R7), and the
// provisioner renews the name for one year through the domain adapter (RenewDomain with the expiry year the row
// holds, which the adapter checks against the live domain). When that operation ends `failed` (the registry
// refused it, or an admin rejected it after its retries, 10.1) the charge is reversed in the transaction of the
// move: one reversing ledger transaction (R5), the credit-note notice where the charge had an invoice, and the
// subscription back at the period that was paid (WPU-Y2: active, no longer ended; see below).
// Once RenewDomain may have been sent the registry may hold the renewal (operations/policy.ts registryHoldsRenewal):
// a poll that gives up and an admin's rejection move no money.
//
// WPU-Y2 (owner rule c, 2026-11-14, delegated money rule). A refusal must not end the subscription for good. Only a
// renewal proven never to have reached the registry ends `failed` (step null, or a definite refusal of the first
// run at `submit`; a refusal at `poll`, the registry's own FAILED included, stops in needs_attention: policy.ts).
// Its charge is reversed as before, but the subscription goes back, ACTIVE, to the period that was paid, and the
// customer can renew again: the retry is charged under the next attempt's ledger key (`renew:<sub>:<start>:a<n>`,
// renewalAttempt) and queues a renew_domain of its own (`...:a<n>`), so the reversed charge's key never blocks it.
// The marker `domainRenewalRefused` (resources.config) stops the lifecycle from charging that period again by
// itself (it would meet the same refusal on every sweep): the engine holds it with an alarm, and the customer's
// renewNow (or a later period) goes on.

const DOMAIN_FAMILY = "domain";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Plain positive decimal text with at most 4 decimals: the form of an awsPriceUsd (the adapter's rule). */
const USD_TEXT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/;

/** A registry renewal that cannot be queued or reversed. The message is fixed text (R14). */
export class DomainRenewalError extends Error {
  override readonly name = "DomainRenewalError";
}

/** An instant stored as the exact ISO text of a Date, or null (the rule of domains/sync.ts). */
function instantOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || at.toISOString() !== value ? null : at;
}

/**
 * The key of the one registry renewal of a period: the form of the lifecycle's own operations
 * (`lifecycle:<kind>:<subscription>:<period start>`), so whoever charges the period (the engine or renewNow)
 * reaches the same row and a replay queues nothing (R7).
 */
export function domainRenewalKey(subscriptionId: string, periodStart: Date, attempt = 0): string {
  const base = `lifecycle:renew-domain:${subscriptionId}:${periodStart.toISOString()}`;
  return attempt === 0 ? base : `${base}:a${attempt}`;
}

/** WPU-Y2. The key of resources.config that marks the period start whose registry renewal was refused. */
export const DOMAIN_RENEWAL_REFUSED_KEY = "domainRenewalRefused";

/**
 * Pure. Whether the lifecycle must not charge the renewal starting at `periodStart` by itself: the registry refused
 * the renewal of exactly that period (the marker names it). A marker that cannot be read blocks too (R16); a marker
 * of another period does not (the customer renewed since).
 * WPU-Y2 fix round 1 (ruling 3): the marker keeps the refused USD price. When the renewal price of today
 * (`currentUsd`, the TLD's renewal price) is another price, the lifecycle tries once more by itself; a refusal of that
 * try writes the marker again with its own price, so each price is tried once. Without a readable price, or the same
 * price, only the customer retries (renewNow).
 */
export function domainRenewalRefused(
  config: Readonly<Record<string, unknown>>,
  periodStart: Date,
  currentUsd: string | null = null,
): boolean {
  const marker = config[DOMAIN_RENEWAL_REFUSED_KEY];
  if (marker === undefined || marker === null) return false;
  if (typeof marker !== "object" || Array.isArray(marker)) return true;
  const fields = marker as Record<string, unknown>;
  const start = instantOf(fields["periodStart"]);
  if (start === null) return true;
  if (start.getTime() !== periodStart.getTime()) return false;
  const refused = fields["maxPriceUsd"];
  if (currentUsd === null || typeof refused !== "string" || !USD_TEXT.test(refused)) return true;
  if (!USD_TEXT.test(currentUsd)) return true;
  return sameDecimalText(refused, currentUsd);
}

/** Pure. Two plain decimal texts name the same amount ("15", "15.0", "15.0000"): no number is made (R4). */
function sameDecimalText(a: string, b: string): boolean {
  const norm = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
  return norm(a) === norm(b);
}

/**
 * WPU-Y2. The attempt under which the renewal of this period is charged now: the first attempt whose ledger key is
 * free, or whose charge stands (a replay of it, R7). An attempt whose charge was reversed (a refused registry
 * renewal, or an admin's reversal) is passed over, so a legitimate retry is charged anew. Only a domain retries: for
 * every other family attempt 0 is the only one, as before. No free attempt left: null, and the caller refuses (R16).
 */
export async function renewalAttempt(
  tx: Tx,
  family: string,
  subscriptionId: string,
  periodStart: Date,
): Promise<number | null> {
  if (family !== DOMAIN_FAMILY) return 0;
  for (let attempt = 0; attempt <= MAX_RENEWAL_ATTEMPT; attempt += 1) {
    const charge = await findLedgerTransactionByKey(
      tx,
      ledgerKey.renewal(subscriptionId, periodStart, attempt),
    );
    if (charge === null || (await findReversalOf(tx, charge.id)) === null) return attempt;
  }
  return null;
}

/**
 * Pure. The `renew_domain` operation that the renewal charge of a domain queues; null for every other family.
 * `maxPriceUsd` is the USD price the renewal charged (WPU-Z19).
 * `currentExpiryYear` is the UTC year of the registry expiry the row holds (`resources.config.expiresAt`, written
 * by the adapter at the registration and at every renewal): RenewDomain's CurrentExpiryYear, which the adapter
 * compares with the live domain before it calls (a later live year is a renewal that already went through).
 * A domain whose expiry cannot be read throws: the caller's transaction, the charge with it, rolls back (R16).
 */
export function domainRenewalOperation(
  row: Pick<LifecycleRow, "id" | "resourceId" | "resource">,
  periodStart: Date,
  maxPriceUsd: string,
  /** WPU-Y2: the attempt of the charge (renewalAttempt); 0 for the first charge of the period. */
  attempt = 0,
): OperationInput | null {
  if (row.resource.family !== DOMAIN_FAMILY) return null;
  // WPU-Z19: the USD price this renewal charged (awsPriceUsd of its price snapshot, decimal text, R4). The adapter sends
  // it as RenewDomain's Consent.MaxPrice, so the registry refuses instead of charging more than the customer paid.
  if (!USD_TEXT.test(maxPriceUsd) || !/[1-9]/.test(maxPriceUsd)) {
    throw new DomainRenewalError("lifecycle: the USD price of the domain renewal is not valid");
  }
  const expiry = instantOf(row.resource.config["expiresAt"]);
  if (expiry === null) {
    throw new DomainRenewalError("lifecycle: the registry expiry of the domain is not known");
  }
  if (!validAttempt(attempt)) {
    throw new DomainRenewalError("lifecycle: the attempt of the domain renewal is not valid");
  }
  return {
    resourceId: row.resourceId,
    kind: "renew_domain",
    // Ids, an instant and two numbers: nothing of the customer's (R11, R14).
    payload: {
      subscriptionId: row.id,
      periodStart: periodStart.toISOString(),
      currentExpiryYear: expiry.getUTCFullYear(),
      years: DOMAIN_YEARS,
      maxPriceUsd,
      ...(attempt === 0 ? {} : { attempt }),
    },
    idempotencyKey: domainRenewalKey(row.id, periodStart, attempt),
  };
}

function validAttempt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_RENEWAL_ATTEMPT
  );
}

/** Pure. The subscription and the period of a `renew_domain` payload, or null when it is not one written here. */
export interface DomainRenewalPayload {
  readonly subscriptionId: string;
  readonly periodStart: Date;
  /** WPU-Y2 fix round 1: the USD price sent as Consent.MaxPrice; null when the payload holds none readable. */
  readonly maxPriceUsd?: string | null;
  /** WPU-Y2: the attempt of the charge; 0 when the payload names none (written before WPU-Y2, or the first). */
  readonly attempt: number;
}

/** Pure. The subscription, the period and the attempt of a `renew_domain` payload, or null when not one written here. */
export function readDomainRenewalPayload(payload: unknown): DomainRenewalPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { subscriptionId, periodStart, attempt, maxPriceUsd } = payload as Record<string, unknown>;
  if (!isUuid(subscriptionId)) return null;
  const start = instantOf(periodStart);
  if (start === null) return null;
  // Written only from 1 on: an explicit 0, or anything else, is not this module's (R16).
  if (attempt !== undefined && (!validAttempt(attempt) || attempt === 0)) return null;
  return {
    subscriptionId,
    periodStart: start,
    attempt: attempt ?? 0,
    maxPriceUsd: typeof maxPriceUsd === "string" && USD_TEXT.test(maxPriceUsd) ? maxPriceUsd : null,
  };
}

export interface ReversalFacts {
  /** The resource and the customer of the failed operation (its row). */
  readonly resourceId: string;
  readonly customerId: string;
  /** The payload of the failed operation, read by readDomainRenewalPayload. */
  readonly payload: Pick<DomainRenewalPayload, "subscriptionId" | "periodStart"> | null;
  /** The subscription the payload names, read under its lock; null when there is none. */
  readonly subscription: {
    readonly id: string;
    readonly resourceId: string;
    readonly customerId: string;
    readonly status: SubscriptionStatus;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly termDays: number;
  } | null;
  /** The ledger transaction under the renewal key of the period; null when there is none. */
  readonly charge: {
    readonly id: string;
    readonly kind: string;
    readonly referenceId: string;
  } | null;
  /** WPU-Y2: the charge was reversed already (an earlier run of this hook, or an admin). */
  readonly alreadyReversed: boolean;
}

export type ReversalDecision =
  | {
      readonly action: "reverse";
      readonly chargeId: string;
      /** The period that was paid, to move the subscription back to (active); null on a replay. */
      readonly rollBack: { readonly periodStart: Date; readonly periodEnd: Date } | null;
    }
  | {
      readonly action: "refuse";
      readonly reason: "payload" | "subscription" | "charge" | "period";
    };

/**
 * Pure. Whether the charge of a failed registry renewal is reversed, and whether the subscription moves back.
 * Anything that does not fit is refused (R16): the caller throws and a person looks (the failed move rolls back,
 * the sweeper escalates the operation to needs_attention).
 */
export function decideDomainRenewalReversal(facts: ReversalFacts): ReversalDecision {
  const { payload, subscription: sub, charge } = facts;
  if (payload === null) return { action: "refuse", reason: "payload" };
  if (
    sub === null ||
    sub.id.toLowerCase() !== payload.subscriptionId.toLowerCase() ||
    sub.resourceId.toLowerCase() !== facts.resourceId.toLowerCase() ||
    sub.customerId.toLowerCase() !== facts.customerId.toLowerCase() ||
    !Number.isInteger(sub.termDays) ||
    sub.termDays < 1
  ) {
    return { action: "refuse", reason: "subscription" };
  }
  if (
    charge === null ||
    charge.kind !== "renewal" ||
    charge.referenceId.toLowerCase() !== sub.id.toLowerCase()
  ) {
    return { action: "refuse", reason: "charge" };
  }
  // WPU-Y2: reversed already: the keyed reversal is a replay and nothing else moves. Never moved back again: the
  // customer may have renewed the period since, under the next attempt.
  if (facts.alreadyReversed) return { action: "reverse", chargeId: charge.id, rollBack: null };
  const paidUntil = payload.periodStart.getTime();
  // The period this charge paid is still the subscription's: move it back to the period before (active).
  if (sub.periodStart.getTime() === paidUntil) {
    return {
      action: "reverse",
      chargeId: charge.id,
      rollBack: {
        periodStart: new Date(paidUntil - sub.termDays * DAY_MS),
        periodEnd: payload.periodStart,
      },
    };
  }
  return { action: "refuse", reason: "period" };
}

/**
 * The hook of a renewal charge (engine.ts afterRenewal, renew-now.ts), in the transaction of the charge, after
 * it: the `renew_domain` of the period for a domain, nothing for any other family. R1: only an operation row; the
 * returned message (a new queued row only) goes out after the commit, or the sweeper sends the row within minutes.
 * A replay of the period finds the stored row and returns null (R7). Throws for a domain whose expiry is not known.
 */
export async function queueDomainRenewal(
  tx: Tx,
  row: LifecycleRow,
  periodStart: Date,
  now: Date,
  maxPriceUsd: string,
  /** WPU-Y2: the attempt of the charge (Renewed.attempt). */
  attempt = 0,
): Promise<QueueMessage | null> {
  const input = domainRenewalOperation(row, periodStart, maxPriceUsd, attempt);
  if (input === null) return null;
  const inserted = await insertOperation(tx, input, now);
  return inserted.created && inserted.state === "queued"
    ? firstMessage(inserted.operationId, row.resourceId)
    : null;
}

/**
 * Final review M2. The lifecycle's renewal charge and its registry renewal (queueDomainRenewal) in one savepoint of
 * the caller's transaction. A domain whose renewal cannot be queued (DomainRenewalError: the expiry or the charged
 * USD price cannot be read) rolls the savepoint back, the charge with it, and comes out as `conflict`: the engine
 * holds the renewal for price_unavailable (hold-rule.ts), so the hold marker is written and its alarm fires, and
 * the next sweep tries again once a person repaired the row. Without the savepoint the throw rolled the whole
 * subscription back on every sweep, with no marker and no alarm. Any other error still reaches the caller (R16).
 */
export async function renewWithRegistry<T>(
  tx: Tx,
  charge: (savepoint: Tx) => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await tx.transaction(charge);
  } catch (error) {
    if (error instanceof DomainRenewalError) return { ok: false, error: "conflict" };
    throw error;
  }
}

/**
 * WPU-Y2 fix round 1 (ruling 4): "We could not renew {domain} at the registry. Your payment has been refunded to your
 * wallet. You can renew it again from the domain page before {expiry}." Once per failed operation (the dedupe key).
 * In a savepoint of its own: a message that cannot be written never holds the refund back; it is logged by id.
 */
async function refundNotice(
  tx: Tx,
  deps: { readonly log?: Logger; readonly notice?: NoticeWriter },
  event: DomainRenewalFailure,
  subscription: { readonly id: string } & Partial<Pick<LifecycleRow, "resource">>,
  paidUntil: Date,
): Promise<void> {
  if (deps.notice === undefined) return;
  const config = subscription.resource?.config ?? {};
  const name = config["name"];
  const expiry = instantOf(config["expiresAt"]) ?? paidUntil;
  try {
    await tx.transaction(async (sp) => {
      await deps.notice!(sp, {
        customerId: event.customerId,
        template: "domain_renewal_refunded",
        data: { domain: typeof name === "string" ? name : "", expiresAt: expiry.toISOString() },
        dedupeKey: `domain-renewal-refunded:${event.operationId}`,
      });
    });
  } catch (error) {
    deps.log?.({
      event: "domain_renewal_notice_failed",
      operationId: event.operationId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export interface DomainRenewalFailure {
  readonly operationId: string;
  readonly resourceId: string;
  readonly customerId: string;
}

export interface DomainRenewalReversed {
  /** The reversing ledger transaction: posted by this call or found (an earlier call's, R7). */
  readonly reversalId: string;
  /** This call moved the subscription back, active, to the period that was paid (WPU-Y2: no longer ended). */
  readonly rolledBack: boolean;
}

/**
 * The failed hook of a `renew_domain` (functions/provisioner), run as worker_rw in the transaction that moves the
 * operation to `failed`: a throw rolls that move back and the sweeper recovers the run. The renewal charge of the
 * period (of the payload's attempt) is reversed under its key (`reversal:<charge>`, R5, R7); reverseTransaction
 * writes the credit-note notice where the charge had an invoice, and the scheduler issues the credit note (WPU-C1).
 * WPU-Y2: the subscription goes back, active, to the period that was paid, and the period is marked refused
 * (DOMAIN_RENEWAL_REFUSED_KEY) so the lifecycle does not charge it again by itself; the customer can renew again.
 * The customer message waits for its wording (no template fits; JOURNEY).
 */
export async function reverseFailedDomainRenewal(
  tx: Tx,
  deps: { readonly log?: Logger; readonly notice?: NoticeWriter },
  event: DomainRenewalFailure,
): Promise<DomainRenewalReversed> {
  const repo = lifecycleRepo(tx);
  const payload = readDomainRenewalPayload(
    await repo.operationPayload(event.resourceId, event.operationId),
  );
  // The lock order of the lifecycle and of renewNow: the subscription row first, then the wallet.
  const subscription = payload === null ? null : await repo.lock(payload.subscriptionId);
  const charge =
    payload === null
      ? null
      : await findLedgerTransactionByKey(
          tx,
          ledgerKey.renewal(payload.subscriptionId, payload.periodStart, payload.attempt),
        );
  const alreadyReversed = charge !== null && (await findReversalOf(tx, charge.id)) !== null;
  const decision = decideDomainRenewalReversal({
    resourceId: event.resourceId,
    customerId: event.customerId,
    payload,
    subscription,
    charge,
    alreadyReversed,
  });
  if (decision.action === "refuse" || subscription === null || payload === null) {
    throw new DomainRenewalError("lifecycle: a failed domain renewal cannot be reversed");
  }

  await lockWallet(tx, event.customerId);
  const reversal = await reverseTransaction(tx, {
    transactionId: decision.chargeId,
    actor: { type: "system" },
    memo: "automatic reversal of a failed domain renewal",
  });
  // A reversal that exists already (this key or an admin's) comes back ok and posts nothing.
  if (!reversal.ok) {
    throw new DomainRenewalError("lifecycle: the reversal of a domain renewal was refused");
  }
  if (decision.rollBack !== null) {
    await repo.setPeriod(subscription.id, { status: "active", ...decision.rollBack });
    await patchResource(tx, event.resourceId, {
      configMerge: {
        [DOMAIN_RENEWAL_REFUSED_KEY]: {
          periodStart: payload.periodStart.toISOString(),
          // WPU-Y2 fix round 1 (ruling 3): the refused price; another renewal price is tried once by itself.
          ...(payload.maxPriceUsd ? { maxPriceUsd: payload.maxPriceUsd } : {}),
        },
      },
    });
    await refundNotice(tx, deps, event, subscription, decision.rollBack.periodEnd);
  }
  const rolledBack = decision.rollBack !== null;
  // Ids and a fixed word only (R14).
  deps.log?.({
    event: "domain_renewal_reversed",
    operationId: event.operationId,
    resourceId: event.resourceId,
    subscriptionId: subscription.id,
    reversalId: reversal.value.transactionId,
    rolledBack,
  });
  return { reversalId: reversal.value.transactionId, rolledBack };
}
