import {
  customerRepos,
  invoiceBacklogRepo,
  type PendingInvoice,
  type UnrecordedCharge,
} from "@tc/db";
import type { Logger, RunTx } from "../operations/types";
import { parseSnapshot } from "../pricing/snapshot";
import type { Clock } from "../types";
import { fiscalYearOf } from "./base";
import { invoiceIdFor, invoiceLinesOf, noteIdFor, queueIdFor, readBuyerSnapshot } from "./charge";

// WPU-I2: the invoices that were owed when the seller details were missing (charge.ts queued them).
// Each run issues the oldest first, one transaction for each invoice, so the numbers follow the order of
// the charge and a rollback of one frees its number (sequential, gap-free per fiscal year). The first
// refusal for the missing seller stops the run: the next ones would be refused as well and an invoice
// must never overtake an older one (R16). A repeat of the run is a replay: one invoice for each ledger
// transaction (R7). The date of issue of such an invoice is the day it is issued, not the day of the
// charge: the invoice says when it was issued. The same holds for the buyer: a backlog invoice carries the
// buyer details (billing profile) current at issue, read in the transaction of the issue (WPU-I4).
//
// WPU-I5. (1) The same stop holds for ANY refusal or failure: the entry is marked failed with a fixed
// reason (the marker is the notice for a person) and the run ends, so that no later entry overtakes it;
// the next run tries it first again. (2) A charge that was reversed is owed no invoice: its queue row is
// closed with the reason charge_reversed. (3) A row that cannot be read is marked unreadable and skipped.
// (4) The fiscal year and the date of issue come from one reading of the clock. (5) Before the run, charges
// that nobody records (no invoice, no queue row, no notice: the charge path could not write either) are
// found and queued (orders, their price snapshot is stored) or noted (renewals, no snapshot is stored); and
// a reversed charge with an issued invoice and no credit-note notice gets the notice.

export const INVOICE_BACKLOG_PAGE = 100;
/** Only charges this recent are reconciled: the gap is a failure of the charge path, not old history. */
export const RECONCILE_WINDOW_DAYS = 7;

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
  /** True when the run stopped at an entry that failed for another reason (it is marked failed). */
  readonly blocked: boolean;
  readonly failed: number;
  /** Rows of the queue that could not be read; they are marked and skipped. */
  readonly unreadable: number;
  /** Queue rows closed because their charge was reversed. */
  readonly reversed: number;
  /** Charges nobody recorded that were queued with their lines by the reconciliation. */
  readonly reconciled: number;
  /** Charges nobody recorded that got a notice only. */
  readonly noted: number;
  /** Credit-note notices written for reversed charges that had an issued invoice. */
  readonly creditNotes: number;
  /** How many were left in the page after the run (not yet issued). */
  readonly remaining: number;
}

export async function runInvoiceBacklog(deps: InvoiceBacklogDeps): Promise<InvoiceBacklogReport> {
  const page = deps.pageSize ?? INVOICE_BACKLOG_PAGE;
  const recon = await reconcile(deps, page);
  const pending = await deps.runTx((tx) => invoiceBacklogRepo(tx).pending(page));
  // Unreadable rows are marked and skipped, so valid entries are not stalled behind them.
  for (const id of pending.unreadableIds) {
    await markSafely(deps, {
      discrepancyId: id,
      ledgerTransactionId: null,
      state: "skipped",
      reason: "unreadable",
    });
  }
  let issued = 0;
  let replayed = 0;
  let failed = 0;
  let reversed = 0;
  let sellerMissing = false;
  let blocked = false;
  let handled = 0;
  for (const entry of pending.items) {
    if (sellerMissing || blocked) break;
    if (entry.reversed) {
      // No invoice for money that went back. Closed, with the reason, and the run goes on.
      const closed = await markSafely(deps, {
        discrepancyId: entry.discrepancyId,
        ledgerTransactionId: entry.ledgerTransactionId,
        state: "resolved",
        reason: "charge_reversed",
      });
      if (closed) {
        reversed += 1;
        handled += 1;
        deps.log({
          event: "invoice_backlog_closed",
          discrepancyId: entry.discrepancyId,
          reason: "charge_reversed",
        });
      }
      continue;
    }
    const outcome = await issueOne(deps, entry);
    if (outcome.kind === "issued") issued += 1;
    else if (outcome.kind === "replayed") replayed += 1;
    else if (outcome.kind === "seller_missing") sellerMissing = true;
    else if (outcome.kind === "reversed") reversed += 1;
    else if (outcome.kind === "failed") {
      // Stop here: nothing after this entry may be issued before it (R16).
      failed += 1;
      blocked = true;
      await markSafely(deps, {
        discrepancyId: entry.discrepancyId,
        ledgerTransactionId: entry.ledgerTransactionId,
        state: "failed",
        reason: outcome.reason,
      });
    }
    if (outcome.kind === "issued" || outcome.kind === "replayed" || outcome.kind === "reversed") {
      handled += 1;
    }
  }
  const report: InvoiceBacklogReport = {
    issued,
    replayed,
    sellerMissing,
    blocked,
    failed,
    unreadable: pending.unreadable,
    reversed,
    reconciled: recon.reconciled,
    noted: recon.noted,
    creditNotes: recon.creditNotes,
    remaining: Math.max(0, pending.items.length - handled - failed),
  };
  return report;
}

async function markSafely(
  deps: InvoiceBacklogDeps,
  mark: Parameters<ReturnType<typeof invoiceBacklogRepo>["mark"]>[0],
): Promise<boolean> {
  try {
    await deps.runTx((tx) => invoiceBacklogRepo(tx).mark(mark));
    return true;
  } catch (error) {
    deps.log({
      event: "invoice_backlog_mark_failed",
      discrepancyId: mark.discrepancyId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

type Outcome =
  | { kind: "issued" | "replayed" | "seller_missing" | "reversed" }
  | { kind: "failed"; reason: string };

async function issueOne(deps: InvoiceBacklogDeps, entry: PendingInvoice): Promise<Outcome> {
  try {
    return await deps.runTx(async (tx): Promise<Outcome> => {
      const invoices = customerRepos(tx, entry.customerId).invoices;
      // One reading of the clock gives the fiscal year AND the date of issue (WPU-I5).
      const at = deps.clock.now();
      const input = {
        id: invoiceIdFor(entry.ledgerTransactionId),
        fiscalYear: fiscalYearOf(at),
        issuedAt: at,
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
      if (written.ok) return { kind: written.replayed ? "replayed" : "issued" };
      if (written.error === "seller_details_missing") return { kind: "seller_missing" };
      if (written.error === "charge_reversed") return { kind: "reversed" };
      // Ids and a fixed code only (R14).
      deps.log({
        event: "invoice_backlog_refused",
        discrepancyId: entry.discrepancyId,
        reason: written.error,
      });
      return { kind: "failed", reason: `refused:${written.error}` };
    });
  } catch (error) {
    deps.log({
      event: "invoice_backlog_failed",
      discrepancyId: entry.discrepancyId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "failed", reason: "error" };
  }
}

// WPU-I5: the charges nobody records. An order is queued with the lines rebuilt from its stored price
// snapshot; anything else (a renewal stores no snapshot, an unreadable snapshot) gets a notice with ids
// only. A failure here never stops the issuing of the queue.
async function reconcile(
  deps: InvoiceBacklogDeps,
  limit: number,
): Promise<{ reconciled: number; noted: number; creditNotes: number }> {
  let reconciled = 0;
  let noted = 0;
  let creditNotes = 0;
  try {
    const lost = await deps.runTx((tx) =>
      invoiceBacklogRepo(tx).unrecorded(limit, RECONCILE_WINDOW_DAYS),
    );
    for (const charge of lost) {
      const kind = await recordOne(deps, charge);
      if (kind === "queued") reconciled += 1;
      else if (kind === "noted") noted += 1;
    }
    const due = await deps.runTx((tx) => invoiceBacklogRepo(tx).creditNotesDue(limit));
    for (const ledgerTransactionId of due) {
      const written = await deps.runTx((tx) =>
        invoiceBacklogRepo(tx).creditNoteNeeded(ledgerTransactionId),
      );
      if (written) creditNotes += 1;
    }
  } catch (error) {
    deps.log({
      event: "invoice_reconcile_failed",
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return { reconciled, noted, creditNotes };
}

async function recordOne(
  deps: InvoiceBacklogDeps,
  charge: UnrecordedCharge,
): Promise<"queued" | "noted" | "failed"> {
  try {
    return await deps.runTx(async (tx) => {
      const invoices = customerRepos(tx, charge.customerId).invoices;
      if (charge.kind === "order" && charge.orderId !== null) {
        try {
          const lines = invoiceLinesOf(parseSnapshot(charge.priceSnapshot));
          const queued = await invoices.queueBacklog({
            id: queueIdFor(charge.ledgerTransactionId),
            kind: "order",
            orderId: charge.orderId,
            ledgerTransactionId: charge.ledgerTransactionId,
            lines,
            totalMinor: charge.totalMinor,
          });
          if (queued.ok) {
            deps.log({
              event: "invoice_reconciled",
              outcome: "queued",
              ledgerTransactionId: charge.ledgerTransactionId,
            });
            return "queued" as const;
          }
        } catch {
          // the lines cannot be rebuilt: fall through to the notice
        }
      }
      const written = await invoices.noteUnrecorded({
        id: noteIdFor(charge.ledgerTransactionId),
        kind: charge.kind,
        ...(charge.orderId === null ? {} : { orderId: charge.orderId }),
        ledgerTransactionId: charge.ledgerTransactionId,
        totalMinor: charge.totalMinor,
      });
      deps.log({
        event: "invoice_reconciled",
        outcome: written.ok ? "noted" : "failed",
        ledgerTransactionId: charge.ledgerTransactionId,
      });
      return written.ok ? ("noted" as const) : ("failed" as const);
    });
  } catch (error) {
    deps.log({
      event: "invoice_reconcile_failed",
      ledgerTransactionId: charge.ledgerTransactionId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return "failed";
  }
}
