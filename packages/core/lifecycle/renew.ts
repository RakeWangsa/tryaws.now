import { lifecycleRepo, type LifecycleRow, type Tx } from "@tc/db";
import { lockWallet } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import { salePostings } from "../ledger/sale-postings";
import { planPriceFor } from "./plan-change";
import { parseSnapshot, type PriceSnapshot } from "../pricing/snapshot";
import { quoteInForce } from "../rates/in-force";
import type { Clock, Result } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// What a renewal would cost today: the stored snapshot gives the AWS price and the quantity; the
// rate and the rule are the ones in force at the clock (section 11: "the renewal amount at today's
// rate"). A snapshot that does not parse, or no rate or rule in force, gives a failure and the
// caller does not charge (R16).
export async function renewalQuote(
  tx: Tx,
  row: Pick<LifecycleRow, "market" | "priceSnapshot" | "resource">,
  clock: Clock,
): Promise<Result<PriceSnapshot>> {
  let stored: PriceSnapshot;
  try {
    stored = parseSnapshot(row.priceSnapshot);
  } catch {
    return { ok: false, error: "internal", fields: { priceSnapshot: "invalid" } };
  }
  // WPU-G8: a pending or applied plan change is priced from its catalog row, by the same engine.
  const plan = await planPriceFor(tx, row);
  if (plan.state === "unreadable") {
    return { ok: false, error: "internal", fields: { plan: "unreadable" } };
  }
  const quoteAt = (awsPriceUsd: string) =>
    quoteInForce(
      tx,
      {
        market: row.market,
        productFamily: row.resource.family,
        awsPriceUsd,
        quantity: stored.quantity,
      },
      clock,
    );
  if (plan.state !== "pending") {
    const priced = await quoteAt(plan.state === "snapshot" ? stored.awsPriceUsd : plan.awsPriceUsd);
    return priced.ok ? { ok: true, value: priced.value.snapshot } : priced;
  }
  // WPU-S4: a pending plan is charged at the higher of its own price and the price of the plan the
  // resource has now (the applied product, else the stored snapshot). The comparison is on the amounts
  // the pricing engine returns, so no decimal math happens here (R4). An upgrade pays the new price
  // (the capacity follows the charge); a downgrade pays the current price for this term and the next
  // renewal quotes the lower applied plan.
  const pending = await quoteAt(plan.awsPriceUsd);
  if (!pending.ok) return pending;
  const current = await quoteAt(plan.floorAwsPriceUsd ?? stored.awsPriceUsd);
  if (!current.ok) return current;
  return {
    ok: true,
    value:
      BigInt(pending.value.snapshot.totalMinor) > BigInt(current.value.snapshot.totalMinor)
        ? pending.value.snapshot
        : current.value.snapshot,
  };
}

export type Renewed = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly totalMinor: bigint;
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
): Promise<Result<Renewed>> {
  const balance = await lockWallet(tx, row.customerId);
  const priced = await renewalQuote(tx, row, clock);
  if (!priced.ok) return priced;
  const fresh = priced.value;
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
  const posted = await postTransaction(tx, {
    kind: "renewal",
    reference: { type: "subscription", id: row.id },
    idempotencyKey: ledgerKey.renewal(row.id, periodStart),
    actor: { type: "system" },
    postings,
  });
  if (!posted.ok) return { ok: false, error: posted.error };

  await lifecycleRepo(tx).setPeriod(row.id, { status: "active", periodStart, periodEnd });
  return { ok: true, value: { periodStart, periodEnd, totalMinor: total } };
}
