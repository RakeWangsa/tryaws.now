import { ledgerKey, openWallet, postTransaction } from "@tc/core";
import type { Result } from "@tc/core";
import { consumeRateLimits, readWalletRow, systemPayments } from "@tc/db";
import type { PaymentRow, Tx } from "@tc/db";
import type { EpsDeps } from "./deps";
import { decide } from "./decide";
import type { VerifyResult } from "./gateway";
import { parseMerchantTransactionId } from "./ids";
import { ipSubject, paymentSubject, RETURN_LIMITS } from "./limits";
import { safeLog } from "./log";
import { isOpen, OPEN_STATES, PAYMENT_STATES, publicState } from "./state";
import type { Action, PaymentState, PublicState, StoredPayment } from "./state";
import type { VerifyReading } from "./status";

export type VerifyOutcome = Result<{ state: PublicState }>;

/** What one pass did, for the sweeper's counts. `credited` means this call posted the credit. */
export type VerifyKind =
  "credited" | "moved" | "review" | "expired" | "unchanged" | "unavailable" | "missing" | "error";

export interface VerifyReport {
  result: VerifyOutcome;
  kind: VerifyKind;
}

const GATEWAY_ID_MAX = 128;
const TEXT_MAX = 128;

/**
 * F: verifyPayment. Called by the return handlers (with a client address, so the return limits apply)
 * and by internal callers (without one). The callback is never trusted: this function asks EPS itself,
 * server to server, for the id it was given, and decides from the locked row (R6, R16).
 */
export async function verifyPayment(
  deps: EpsDeps,
  merchantTransactionId: string,
  ctx?: { clientIp?: string },
): Promise<VerifyOutcome> {
  return (await verifyOnce(deps, merchantTransactionId, { ctx })).result;
}

export interface VerifyOptions {
  ctx?: { clientIp?: string };
  /** Sweeper: an open payment created at or before this time, for which EPS did not say success, becomes expired. */
  expireBefore?: Date;
}

export async function verifyOnce(
  deps: EpsDeps,
  merchantTransactionId: string,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  try {
    return await run(deps, merchantTransactionId, options);
  } catch {
    // R16: nothing is promised about a payment when a check threw. No error text is passed on (R14).
    safeLog(deps, "eps.verify", { reason: "exception" });
    return { result: { ok: false, error: "internal" }, kind: "error" };
  }
}

const refused = (error: "not_found" | "internal" | "upstream_unavailable"): VerifyReport => ({
  result: { ok: false, error },
  kind:
    error === "upstream_unavailable" ? "unavailable" : error === "not_found" ? "missing" : "error",
});

async function run(
  deps: EpsDeps,
  merchantTransactionId: string,
  options: VerifyOptions,
): Promise<VerifyReport> {
  // 1. An id that cannot be one of ours is "no such payment", with no query and no EPS call.
  const id = parseMerchantTransactionId(merchantTransactionId);
  if (id === null) return refused("not_found");

  // 2. The address rule of the browser-facing path (a caller with an address). The per-payment rule
  // waits for a payment that exists, so random well-formed ids cannot grow the limiter table.
  if (options.ctx !== undefined) {
    const limited = await limitReturn(deps, id, options.ctx.clientIp, "ip");
    if (limited !== null) return { result: limited, kind: "error" };
  }

  // 3. Transaction A: read without a lock. Only cheap answers come from it, never a decision.
  const first = await deps.run((tx) =>
    systemPayments.byMerchantTransactionId(tx, id, { lock: false }),
  );
  if (first === null) return refused("not_found");
  if (options.ctx !== undefined) {
    const limited = await limitReturn(deps, id, options.ctx.clientIp, "payment");
    if (limited !== null) return { result: limited, kind: "error" };
  }
  if (first.status === "credited") return answered("credited", "unchanged");
  if (first.status === "review") return answered("pending", "unchanged");

  // 4. Outside any transaction: ask EPS.
  let asked: VerifyResult;
  try {
    asked = await deps.gateway.verify(id);
  } catch {
    asked = { ok: false, reason: "unavailable" };
  }
  if (!asked.ok) {
    safeLog(deps, "eps.verify", { paymentId: first.id, reason: "unavailable" });
    return refused("upstream_unavailable");
  }
  const reading = sanitize(asked.reading);

  // 5. Transaction B: the locked row decides. `first` is not used below.
  const applied = await deps.run((tx) => settle(deps, tx, id, reading, options));
  if (applied === null) return refused("not_found");

  // After the commit: the alert. A failing alert never hides the result and is not retried here.
  if (applied.alert !== null) {
    try {
      await deps.alert.raise(applied.alert);
    } catch {
      safeLog(deps, "eps.verify", { paymentId: applied.paymentId, reason: "alert_failed" });
    }
  }
  safeLog(deps, "eps.verify", { paymentId: applied.paymentId, state: applied.status });
  return answered(publicState(applied.status), applied.kind);
}

function answered(state: PublicState, kind: VerifyKind): VerifyReport {
  return { result: { ok: true, value: { state } }, kind };
}

async function limitReturn(
  deps: EpsDeps,
  id: string,
  clientIp: string | undefined,
  part: "ip" | "payment",
): Promise<VerifyOutcome | null> {
  const now = deps.clock.now();
  // The payment subject is a keyed hash of a different label than an address, so the two never meet.
  let rules: { kind: "ip"; subject: string; action: string; limit: number; windowSeconds: number }[];
  if (part === "ip") {
    // An address that is given must be one (R16); an absent address skips only the per-address rule.
    if (clientIp === undefined) return null;
    const ip = ipSubject(deps.limitKey, clientIp);
    if (ip === null) return { ok: false, error: "validation", fields: { clientIp: "invalid" } };
    rules = [{ kind: "ip", subject: ip, ...RETURN_LIMITS.ip }];
  } else {
    const payment = paymentSubject(deps.limitKey, id);
    if (payment === null) return { ok: false, error: "internal" };
    rules = [{ kind: "ip", subject: payment, ...RETURN_LIMITS.payment }];
  }
  const decision = await deps.run((tx) => consumeRateLimits(tx, rules, now));
  return decision.allowed
    ? null
    : { ok: false, error: "rate_limited", data: { retryAfterSeconds: decision.retryAfterSeconds } };
}

interface Applied {
  paymentId: string;
  status: PaymentState;
  kind: VerifyKind;
  alert: {
    kind: "payment_review";
    paymentId: string;
    reason: string;
    expectedMinor: bigint;
    gotMinor: bigint | null;
  } | null;
}

// An EPS transaction id longer than the column is not stored (the credit must not get stuck on it).
function sanitize(reading: VerifyReading): VerifyReading {
  const eps = reading.epsTransactionId;
  return eps !== null && (eps.length < 1 || eps.length > GATEWAY_ID_MAX)
    ? { ...reading, epsTransactionId: null }
    : reading;
}

function toStored(row: PaymentRow): StoredPayment {
  if (!(PAYMENT_STATES as readonly string[]).includes(row.status)) {
    throw new TypeError("payment: unknown status");
  }
  return {
    id: row.id,
    customerId: row.customerId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status as PaymentState,
    merchantTransactionId: row.merchantTransactionId,
    gatewayTransactionId: row.gatewayTransactionId,
    createdAt: row.createdAt,
  };
}

// totalAmount as the decimal text of EPS, from paisa by string arithmetic (R4).
function decimalText(minor: bigint | null): string | null {
  if (minor === null) return null;
  const s = (minor < 0n ? -minor : minor).toString().padStart(3, "0");
  return `${minor < 0n ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

const clip = (v: string | null): string | null => (v === null ? null : v.slice(0, TEXT_MAX));

// The stored payload is built from the reading, field by field (never the raw body).
function allowlisted(reading: VerifyReading): Record<string, string | null> {
  return {
    status: reading.status,
    merchantTransactionId: clip(reading.merchantTransactionId),
    epsTransactionId: clip(reading.epsTransactionId),
    totalAmount: decimalText(reading.totalAmountMinor),
  };
}

async function settle(
  deps: EpsDeps,
  tx: Tx,
  id: string,
  reading: VerifyReading,
  options: VerifyOptions,
): Promise<Applied | null> {
  const row = await systemPayments.byMerchantTransactionId(tx, id, { lock: true });
  if (row === null) return null;
  const payment = toStored(row);
  const now = deps.clock.now();

  const used =
    reading.status === "success" && reading.epsTransactionId !== null
      ? await systemPayments.gatewayIdUsedElsewhere(tx, reading.epsTransactionId, payment.id)
      : false;
  const action: Action = decide({ payment, reading, gatewayIdUsedElsewhere: used });
  const payload = allowlisted(reading);
  const fields = { verifyPayload: payload, verifiedAt: now };
  const done = (status: PaymentState, kind: VerifyKind): Applied => ({
    paymentId: payment.id,
    status,
    kind,
    alert: null,
  });

  switch (action.type) {
    case "credit": {
      // The wallet exists from sign-up. Only a missing one is opened (worker_rw cannot insert wallets).
      if ((await readWalletRow(tx, payment.customerId.toLowerCase())) === null) {
        const opened = await openWallet(tx, payment.customerId);
        if (!opened.ok) throw new Error("credit: no wallet");
      }
      const posted = await postTransaction(tx, {
        kind: "topup",
        reference: { type: "payment", id: payment.id },
        idempotencyKey: ledgerKey.topup(payment.id),
        actor: { type: "system" },
        postings: [
          {
            account: { type: "gateway_clearing" },
            direction: "debit",
            amountMinor: payment.amountMinor,
          },
          {
            account: { type: "customer_wallet", customerId: payment.customerId },
            direction: "credit",
            amountMinor: payment.amountMinor,
          },
        ],
      });
      // A refused post throws: the transaction rolls back and nothing is credited (R16).
      if (!posted.ok) throw new Error("credit: the ledger refused the post");
      const moved = await systemPayments.applyOutcome(tx, payment.id, OPEN_STATES, "credited", {
        ...fields,
        ...(action.gatewayTransactionId !== null
          ? { gatewayTransactionId: action.gatewayTransactionId }
          : {}),
        ledgerTransactionId: posted.value.transactionId,
      });
      // The guard says the row was not open any more: roll the credit back, no double (R6).
      if (!moved) throw new Error("credit: the payment was not open");
      await deps.onCredited?.(tx, { ...payment, status: "credited" });
      return done("credited", "credited");
    }
    case "move": {
      const moved = await systemPayments.applyOutcome(
        tx,
        payment.id,
        OPEN_STATES,
        action.to,
        fields,
      );
      if (!moved) throw new Error("move: the payment was not open");
      return done(action.to, "moved");
    }
    case "review": {
      const from: readonly string[] = isOpen(payment.status) ? OPEN_STATES : [payment.status];
      const moved = await systemPayments.applyOutcome(tx, payment.id, from, "review", fields);
      if (!moved) throw new Error("review: the payment changed");
      await systemPayments.recordDiscrepancy(tx, {
        paymentId: payment.id,
        reason: action.reason,
        expectedMinor: payment.amountMinor,
        gotMinor: reading.totalAmountMinor,
        state: payment.status,
      });
      return {
        paymentId: payment.id,
        status: "review",
        kind: "review",
        alert: {
          kind: "payment_review",
          paymentId: payment.id,
          reason: action.reason,
          expectedMinor: payment.amountMinor,
          gotMinor: reading.totalAmountMinor,
        },
      };
    }
    case "noop": {
      // Sweeper: an open payment that is old enough and for which EPS said no success expires.
      if (
        options.expireBefore !== undefined &&
        isOpen(payment.status) &&
        payment.createdAt.getTime() <= options.expireBefore.getTime() &&
        action.reason === "pending"
      ) {
        const moved = await systemPayments.applyOutcome(
          tx,
          payment.id,
          OPEN_STATES,
          "expired",
          fields,
        );
        if (!moved) throw new Error("expire: the payment was not open");
        return done("expired", "expired");
      }
      return done(payment.status, "unchanged");
    }
  }
}
