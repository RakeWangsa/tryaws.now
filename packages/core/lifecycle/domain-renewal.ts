import {
  findLedgerTransactionByKey,
  insertOperation,
  lifecycleRepo,
  type LifecycleRow,
  type OperationInput,
  type SubscriptionStatus,
  type Tx,
} from "@tc/db";
import { DOMAIN_YEARS } from "../domains/resolve";
import { lockWallet } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { reverseTransaction } from "../ledger/reverse";
import { firstMessage, type QueueMessage } from "../operations/queue";
import type { Logger } from "../operations/types";

// WPU-Z13. A domain's renewal charge (the lifecycle at the period end, or renewNow) pays for a renewal at the
// registry: in the transaction of the charge one `renew_domain` operation is queued for the period (R7), and the
// provisioner renews the name for one year through the domain adapter (RenewDomain with the expiry year the row
// holds, which the adapter checks against the live domain). When that operation ends `failed` (the registry
// refused it, or an admin rejected it after its retries, 10.1) the charge is reversed in the transaction of the
// move: one reversing ledger transaction (R5), the credit-note notice where the charge had an invoice, and the
// subscription back at the period that was paid, ended. Ended, because the ledger key of the renewal stays taken:
// a renewal of the same period again would be a replay of the reversed charge, a period for nothing.

const DOMAIN_FAMILY = "domain";
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export function domainRenewalKey(subscriptionId: string, periodStart: Date): string {
  return `lifecycle:renew-domain:${subscriptionId}:${periodStart.toISOString()}`;
}

/**
 * Pure. The `renew_domain` operation that the renewal charge of a domain queues; null for every other family.
 * `currentExpiryYear` is the UTC year of the registry expiry the row holds (`resources.config.expiresAt`, written
 * by the adapter at the registration and at every renewal): RenewDomain's CurrentExpiryYear, which the adapter
 * compares with the live domain before it calls (a later live year is a renewal that already went through).
 * A domain whose expiry cannot be read throws: the caller's transaction, the charge with it, rolls back (R16).
 */
export function domainRenewalOperation(
  row: Pick<LifecycleRow, "id" | "resourceId" | "resource">,
  periodStart: Date,
): OperationInput | null {
  if (row.resource.family !== DOMAIN_FAMILY) return null;
  const expiry = instantOf(row.resource.config["expiresAt"]);
  if (expiry === null) {
    throw new DomainRenewalError("lifecycle: the registry expiry of the domain is not known");
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
    },
    idempotencyKey: domainRenewalKey(row.id, periodStart),
  };
}

/** Pure. The subscription and the period of a `renew_domain` payload, or null when it is not one written here. */
export function readDomainRenewalPayload(
  payload: unknown,
): { readonly subscriptionId: string; readonly periodStart: Date } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { subscriptionId, periodStart } = payload as Record<string, unknown>;
  if (typeof subscriptionId !== "string" || !UUID.test(subscriptionId)) return null;
  const start = instantOf(periodStart);
  return start === null ? null : { subscriptionId, periodStart: start };
}

export interface ReversalFacts {
  /** The resource and the customer of the failed operation (its row). */
  readonly resourceId: string;
  readonly customerId: string;
  /** The payload of the failed operation, read by readDomainRenewalPayload. */
  readonly payload: { readonly subscriptionId: string; readonly periodStart: Date } | null;
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
}

export type ReversalDecision =
  | {
      readonly action: "reverse";
      readonly chargeId: string;
      /** The period that was paid, to move the subscription back to (and end it); null when it is there already. */
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
  const paidUntil = payload.periodStart.getTime();
  // The period this charge paid is still the subscription's: move it back to the period before, and end it.
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
  // An earlier call moved it back and ended it: the keyed reversal is a replay, nothing else moves.
  if (sub.status === "ended" && sub.periodEnd.getTime() === paidUntil) {
    return { action: "reverse", chargeId: charge.id, rollBack: null };
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
): Promise<QueueMessage | null> {
  const input = domainRenewalOperation(row, periodStart);
  if (input === null) return null;
  const inserted = await insertOperation(tx, input, now);
  return inserted.created && inserted.state === "queued"
    ? firstMessage(inserted.operationId, row.resourceId)
    : null;
}

export interface DomainRenewalFailure {
  readonly operationId: string;
  readonly resourceId: string;
  readonly customerId: string;
}

export interface DomainRenewalReversed {
  /** The reversing ledger transaction: posted by this call or found (an earlier call's, R7). */
  readonly reversalId: string;
  /** This call moved the subscription back to the period that was paid and ended it. */
  readonly ended: boolean;
}

/**
 * The failed hook of a `renew_domain` (functions/provisioner), run as worker_rw in the transaction that moves the
 * operation to `failed`: a throw rolls that move back and the sweeper recovers the run. The renewal charge of the
 * period is reversed under its key (`reversal:<charge>`, R5, R7); reverseTransaction writes the credit-note notice
 * where the charge had an invoice, and the scheduler issues the credit note (WPU-C1). The subscription goes back to
 * the period that was paid and ends. The customer message waits for its wording (no template fits; JOURNEY).
 */
export async function reverseFailedDomainRenewal(
  tx: Tx,
  deps: { readonly log?: Logger },
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
          ledgerKey.renewal(payload.subscriptionId, payload.periodStart),
        );
  const decision = decideDomainRenewalReversal({
    resourceId: event.resourceId,
    customerId: event.customerId,
    payload,
    subscription,
    charge,
  });
  if (decision.action === "refuse" || subscription === null) {
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
    await repo.setPeriod(subscription.id, { status: "ended", ...decision.rollBack });
  }
  const ended = decision.rollBack !== null;
  // Ids and a fixed word only (R14).
  deps.log?.({
    event: "domain_renewal_reversed",
    operationId: event.operationId,
    resourceId: event.resourceId,
    subscriptionId: subscription.id,
    reversalId: reversal.value.transactionId,
    ended,
  });
  return { reversalId: reversal.value.transactionId, ended };
}
