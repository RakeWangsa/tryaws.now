import { createHash } from "node:crypto";
import { customerRepos, invoiceBacklogRepo, type CreditNoteToIssue } from "@tc/db";
import type { InvoiceBacklogDeps } from "./backlog";
import { fiscalYearOf } from "./base";

// WPU-C1 (ruling 6): the credit note (Mushak-6.7, Credit Note / ক্রেডিট নোট) of a reversed charge that has an
// issued invoice. reverseTransaction (WPU-I5) already writes the `credit_note_needed` notice from its own seam;
// this is the scheduler step that issues the document. Nothing here touches the ledger and no amount is
// computed: the repository copies the lines (with their stored VAT split), the seller snapshot and the buyer
// snapshot from the ORIGINAL invoice, and refuses (R16) when the reversal does not give back exactly the total
// of that invoice. A partial credit note is a Needs decision and is not built.
//
// One transaction for each credit note: a failure rolls the number back (gap-free, own sequence for each fiscal
// year). The id of the row is derived from the reversal transaction and the row is unique on it (R7), so a
// repeat of the run is a replay. A refused credit note stays an open notice for a person; the run goes on.

/** The id of the credit note of a reversal: the same reversal always gives the same id (R7). */
export function creditNoteIdFor(reversalTransactionId: string): string {
  const bytes = createHash("sha256")
    .update(`credit-note|${reversalTransactionId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * WPU-B3. A credit note that is refused or fails for this long after its reversal is escalated: one
 * `credit_note_stuck` line with severity "alert" for each such note in each run, which the stage alarm
 * matches (infra/stacks/alarms.ts). A person must then look at the notice. 24 hours is one day of the
 * hourly-or-faster scheduler, long enough for a seller detail fixed by a person, short enough for a
 * tax document that is owed.
 */
export const CREDIT_NOTE_STUCK_HOURS = 24;
export const CREDIT_NOTE_STUCK_EVENT = "credit_note_stuck";
const HOUR_MS = 3_600_000;

/** Pure. A date that cannot be read counts as stuck (R16). */
export function creditNoteIsStuck(reversedAt: Date, now: Date): boolean {
  const age = now.getTime() - reversedAt.getTime();
  if (Number.isNaN(age)) return true;
  return age >= CREDIT_NOTE_STUCK_HOURS * HOUR_MS;
}

export interface CreditNoteRun {
  readonly issued: number;
  readonly replayed: number;
  /** Refused or failed: left as open notices, with a fixed reason in the log. */
  readonly refused: number;
  /** WPU-B3: of the refused ones, those older than CREDIT_NOTE_STUCK_HOURS (alerted in this run). */
  readonly stuck: number;
}

function escalate(deps: InvoiceBacklogDeps, entry: CreditNoteToIssue, reason: string): boolean {
  const now = deps.clock.now();
  if (!creditNoteIsStuck(entry.reversedAt, now)) return false;
  const age = (now.getTime() - entry.reversedAt.getTime()) / HOUR_MS;
  deps.log({
    event: CREDIT_NOTE_STUCK_EVENT,
    severity: "alert",
    ledgerTransactionId: entry.ledgerTransactionId,
    reason,
    // Whole hours; null when the age cannot be computed.
    ageHours: Number.isFinite(age) ? Math.floor(age) : null,
  });
  return true;
}

async function issueOne(
  deps: InvoiceBacklogDeps,
  entry: CreditNoteToIssue,
): Promise<{ outcome: "issued" | "replayed" | "refused"; reason?: string }> {
  try {
    return await deps.runTx(async (tx) => {
      // One reading of the clock gives the fiscal year AND the date of issue.
      const at = deps.clock.now();
      const written = await customerRepos(tx, entry.customerId).invoices.issueCreditNote({
        id: creditNoteIdFor(entry.reversalTransactionId),
        reversalTransactionId: entry.reversalTransactionId,
        fiscalYear: fiscalYearOf(at),
        issuedAt: at,
      });
      if (!written.ok) {
        // Ids and a fixed code only (R14).
        deps.log({
          event: "credit_note_refused",
          ledgerTransactionId: entry.ledgerTransactionId,
          reason: written.error,
        });
        return { outcome: "refused" as const, reason: written.error };
      }
      await invoiceBacklogRepo(tx).resolveCreditNoteNotice(entry.ledgerTransactionId);
      return { outcome: written.replayed ? ("replayed" as const) : ("issued" as const) };
    });
  } catch (error) {
    deps.log({
      event: "credit_note_failed",
      ledgerTransactionId: entry.ledgerTransactionId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { outcome: "refused", reason: error instanceof Error ? error.name : "unknown" };
  }
}

/** Issues the credit notes that are due, oldest reversal first. Never throws. */
export async function issueCreditNotes(
  deps: InvoiceBacklogDeps,
  limit: number,
): Promise<CreditNoteRun> {
  let issued = 0;
  let replayed = 0;
  let refused = 0;
  let stuck = 0;
  try {
    const due = await deps.runTx((tx) => invoiceBacklogRepo(tx).creditNotesToIssue(limit));
    for (const entry of due) {
      const done = await issueOne(deps, entry);
      if (done.outcome === "issued") issued += 1;
      else if (done.outcome === "replayed") replayed += 1;
      else {
        refused += 1;
        if (escalate(deps, entry, done.reason ?? "unknown")) stuck += 1;
      }
    }
  } catch (error) {
    deps.log({
      event: "credit_note_run_failed",
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return { issued, replayed, refused, stuck };
}
