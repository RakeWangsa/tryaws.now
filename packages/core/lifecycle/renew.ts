import { lifecycleRepo, type LifecycleRow, type Tx } from "@tc/db";
import { lockWallet } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import type { Posting } from "../ledger/types";
import { accountFor } from "../pricing/index";
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
  return priced.ok ? { ok: true, value: priced.value.snapshot } : priced;
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

  const postings: Posting[] = [
    {
      account: { type: "customer_wallet", customerId: row.customerId },
      direction: "debit",
      amountMinor: total,
    },
    {
      account: { type: "revenue_aws_base" },
      direction: "credit",
      amountMinor: BigInt(fresh.baseMinor),
    },
  ];
  for (const step of fresh.steps) {
    const amountMinor = BigInt(step.amountMinor);
    if (amountMinor === 0n) continue; // a step of 0 posts no line
    const type = accountFor(step.code);
    if (type === undefined) throw new Error("lifecycle: a price step has no ledger account");
    postings.push({ account: { type }, direction: "credit", amountMinor });
  }

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
