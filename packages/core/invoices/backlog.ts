import { customerRepos, invoiceBacklogRepo, type PendingInvoice } from "@tc/db";
import type { Logger, RunTx } from "../operations/types";
import type { Clock } from "../types";
import { fiscalYearOf } from "./base";
import { invoiceIdFor, readBuyerSnapshot } from "./charge";

// WPU-I2: the invoices that were owed when the seller details were missing (charge.ts queued them).
// Each run issues the oldest first, one transaction for each invoice, so the numbers follow the order of
// the charge and a rollback of one frees its number (sequential, gap-free per fiscal year). The first
// refusal for the missing seller stops the run: the next ones would be refused as well and an invoice
// must never overtake an older one (R16). A repeat of the run is a replay: one invoice for each ledger
// transaction (R7). The date of issue of such an invoice is the day it is issued, not the day of the
// charge: the invoice says when it was issued. The same holds for the buyer: a backlog invoice carries the
// buyer details (billing profile) current at issue, read in the transaction of the issue (WPU-I4).

export const INVOICE_BACKLOG_PAGE = 100;

export interface InvoiceBacklogDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly log: Logger;
  readonly pageSize?: number;
}

export interface InvoiceBacklogReport {
  readonly issued: number;
  readonly replayed: number;
  /** True when the run stopped because the seller details are still missing. */
  readonly sellerMissing: boolean;
  readonly failed: number;
  /** Rows of the queue that cannot be read; they need a person. */
  readonly unreadable: number;
  /** How many were left in the page after the run (not yet issued). */
  readonly remaining: number;
}

export async function runInvoiceBacklog(deps: InvoiceBacklogDeps): Promise<InvoiceBacklogReport> {
  const page = deps.pageSize ?? INVOICE_BACKLOG_PAGE;
  const pending = await deps.runTx((tx) => invoiceBacklogRepo(tx).pending(page));
  let issued = 0;
  let replayed = 0;
  let failed = 0;
  let sellerMissing = false;
  for (const entry of pending.items) {
    if (sellerMissing) break;
    const outcome = await issueOne(deps, entry);
    if (outcome === "issued") issued += 1;
    else if (outcome === "replayed") replayed += 1;
    else if (outcome === "seller_missing") sellerMissing = true;
    else failed += 1;
  }
  const report: InvoiceBacklogReport = {
    issued,
    replayed,
    sellerMissing,
    failed,
    unreadable: pending.unreadable,
    remaining: pending.items.length - issued - replayed - failed,
  };
  return report;
}

async function issueOne(
  deps: InvoiceBacklogDeps,
  entry: PendingInvoice,
): Promise<"issued" | "replayed" | "seller_missing" | "failed"> {
  try {
    return await deps.runTx(async (tx) => {
      const invoices = customerRepos(tx, entry.customerId).invoices;
      const input = {
        id: invoiceIdFor(entry.ledgerTransactionId),
        fiscalYear: fiscalYearOf(deps.clock.now()),
        lines: entry.lines,
        totalMinor: entry.totalMinor,
        // The buyer details current at ISSUE (the backlog run), not at the charge: the invoice says the
        // day it is issued, and the profile is read in this same transaction.
        buyer: await readBuyerSnapshot(tx, entry.customerId),
      };
      const written =
        entry.kind === "order" && entry.orderId !== null
          ? await invoices.issue({ ...input, orderId: entry.orderId })
          : await invoices.issueForCharge({
              ...input,
              ledgerTransactionId: entry.ledgerTransactionId,
            });
      if (written.ok) return written.replayed ? "replayed" : "issued";
      if (written.error === "seller_details_missing") return "seller_missing";
      // Ids and a fixed code only (R14).
      deps.log({
        event: "invoice_backlog_refused",
        discrepancyId: entry.discrepancyId,
        reason: written.error,
      });
      return "failed";
    });
  } catch (error) {
    deps.log({
      event: "invoice_backlog_failed",
      discrepancyId: entry.discrepancyId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return "failed";
  }
}
