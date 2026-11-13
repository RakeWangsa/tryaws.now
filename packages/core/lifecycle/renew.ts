import { lifecycleRepo, readTld, type LifecycleRow, type Tx } from "@tc/db";
import { DOMAIN_YEARS } from "../domains/resolve";
import { domainRenewalUsd } from "../domains/renewal";
import { renewalAttempt } from "./domain-renewal";
import { issueChargeInvoice } from "../invoices/charge";
import { lockWallet } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import { salePostings } from "../ledger/sale-postings";
import type { Logger } from "../operations/types";
import { planPriceFor } from "./plan-change";
import { parseSnapshot, type PriceSnapshot } from "../pricing/snapshot";
import { quoteInForce, type PricedItem } from "../rates/in-force";
import { buildChargeSnapshot } from "../pricing/charge-snapshot";
import type { Clock, Result } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What a renewal would cost today: the stored snapshot gives the AWS price and the quantity; the
// rate and the rule are the ones in force at the clock (section 11: "the renewal amount at today's
// rate"). A snapshot that does not parse, or no rate or rule in force, gives a failure and the
// caller does not charge (R16). WPU-Y2: a domain's AWS price is the renewal price of its TLD row instead.
export async function renewalQuote(
  tx: Tx,
  row: Pick<LifecycleRow, "market" | "priceSnapshot" | "resource">,
  clock: Clock,
): Promise<Result<PriceSnapshot>> {
  const priced = await renewalPriced(tx, row, clock);
  return priced.ok ? { ok: true, value: priced.value.snapshot } : priced;
}

// WPU-Y2: the same pricing with all its inputs, for the charge snapshot of the renewal.
async function renewalPriced(
  tx: Tx,
  row: Pick<LifecycleRow, "market" | "priceSnapshot" | "resource">,
  clock: Clock,
): Promise<Result<PricedItem>> {
  let stored: PriceSnapshot;
  try {
    stored = parseSnapshot(row.priceSnapshot);
  } catch {
    return { ok: false, error: "internal", fields: { priceSnapshot: "invalid" } };
  }
  // WPU-Y2 (owner rule a, 2026-11-14): a domain renews at tlds.renewal_price_usd of its TLD, read today, through the
  // same engine as a purchase (rate of the renewal day, markup, fees, VAT, rounding). Never the registration price
  // of the purchase snapshot. No usable renewal price refuses (R16): the engine holds the renewal with an alarm.
  if (row.resource.family === "domain") {
    const productId = row.resource.config["productId"];
    const tld =
      typeof productId === "string" && UUID.test(productId) ? await readTld(tx, productId) : null;
    const usd = domainRenewalUsd(row.resource.config, tld);
    if (!usd.ok) return usd;
    return quoteInForce(
      tx,
      {
        market: row.market,
        productFamily: row.resource.family,
        awsPriceUsd: usd.value,
        quantity: String(DOMAIN_YEARS),
      },
      clock,
    );
  }
  // WPU-G8: an applied plan change is priced from its catalog row, by the same engine.
  const plan = await planPriceFor(tx, row);
  if (plan.state === "unreadable") {
    return { ok: false, error: "internal", fields: { plan: "unreadable" } };
  }
  // WPU-S5: the renewal prices exactly the plan the resource has (the applied plan, else the stored
  // snapshot). A pending plan is never priced: it is charged only once the apply made it the applied
  // plan, so the charge follows the delivered capacity.
  const priced = await quoteInForce(
    tx,
    {
      market: row.market,
      productFamily: row.resource.family,
      awsPriceUsd: plan.state === "snapshot" ? stored.awsPriceUsd : plan.awsPriceUsd,
      quantity: stored.quantity,
    },
    clock,
  );
  return priced;
}

export type Renewed = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly totalMinor: bigint;
  /** WPU-Z19: the USD price this renewal charged (awsPriceUsd of its price snapshot, decimal text, R4). */
  readonly awsPriceUsd: string;
  /** WPU-Y2: the attempt of the charge (its ledger key); above 0 only for a domain charged again after a refusal. */
  readonly attempt: number;
};

// Charges the wallet once and moves the period: the new period starts at the OLD period end (also
// from grace), and lasts the subscription's term. Everything is in the caller's transaction, under
// the wallet lock and the lock of the subscription row (engine.ts): the ledger key
// `renew:<subscription>:<new period start>` makes a repeat a replay, never a second charge (R7).
// A short wallet is `insufficient_balance` and nothing is written. The stored price_snapshot is not
// refreshed: worker_rw has no grant on it (the ledger holds the amount that was charged).
export async function renewSubscription(
  tx: Tx,
  row: LifecycleRow,
  clock: Clock,
  log?: Logger,
): Promise<Result<Renewed>> {
  const balance = await lockWallet(tx, row.customerId);
  // The renewal is priced NOW (section 11: today's rate and rule), and the inputs are saved with the charge
  // as a new snapshot (WPU-Y2): the invoice and a credit note are rebuilt from it, never recalculated.
  const priced = await renewalPriced(tx, row, clock);
  if (!priced.ok) return priced;
  const fresh = priced.value.snapshot;
  const charge = buildChargeSnapshot("renewal", priced.value.charge);
  const total = BigInt(fresh.totalMinor);
  if (balance < total) {
    return {
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: (total - balance).toString() },
    };
  }

  // WPU-M2: the split is built by the one builder that the purchase and the metered charge also use.
  const postings = salePostings(row.customerId, {
    totalMinor: total,
    baseMinor: BigInt(fresh.baseMinor),
    steps: fresh.steps.map((s) => ({ code: s.code, amountMinor: BigInt(s.amountMinor) })),
  });

  const periodStart = row.periodEnd;
  const periodEnd = new Date(periodStart.getTime() + row.termDays * DAY_MS);
  // WPU-Y2: the first attempt of the period whose charge was not reversed (attempt 0 for every family but a domain).
  const attempt = await renewalAttempt(tx, row.resource.family, row.id, periodStart);
  if (attempt === null) return { ok: false, error: "conflict", fields: { renewal: "attempts" } };
  const posted = await postTransaction(tx, {
    kind: "renewal",
    reference: { type: "subscription", id: row.id },
    idempotencyKey: ledgerKey.renewal(row.id, periodStart, attempt),
    actor: { type: "system" },
    priceSnapshot: charge,
    postings,
  });
  if (!posted.ok) return { ok: false, error: posted.error };

  await lifecycleRepo(tx).setPeriod(row.id, { status: "active", periodStart, periodEnd });
  // WPU-I2: the tax invoice of this renewal (spec 9.3), once for the charge: a replay of the posting
  // finds the invoice of the first call. It never fails the renewal: without seller details it is queued.
  await issueChargeInvoice(tx, {
    customerId: row.customerId,
    charge: { kind: "renewal" },
    ledgerTransactionId: posted.value.transactionId,
    snapshot: fresh,
    now: clock.now(),
    ...(log === undefined ? {} : { log }),
  });
  return {
    ok: true,
    value: { periodStart, periodEnd, totalMinor: total, awsPriceUsd: fresh.awsPriceUsd, attempt },
  };
}
