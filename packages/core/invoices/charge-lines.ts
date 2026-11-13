import { chargeToPriceSnapshot, readChargeSnapshot } from "../pricing/charge-snapshot";
import { invoiceLinesOf } from "./charge";
import { InvoiceError, type InvoiceLine } from "./base";

// WPU-Y2: the lines of an invoice or a credit note come ONLY from the saved charge snapshot
// (ledger_transactions.price_snapshot). No rate, rule or price book is read here: there is no way in
// this function to recalculate. A charge from before the snapshot existed (legacy) is rendered from the
// lines that were stored with its invoice; a damaged or unknown snapshot refuses (R16).

export interface ChargeLines {
  readonly source: "snapshot" | "legacy";
  readonly lines: InvoiceLine[];
}

/**
 * @param stored the value of ledger_transactions.price_snapshot
 * @param legacyLines the lines stored with an invoice that already exists (used only for a legacy charge)
 */
export function resolveChargeLines(
  stored: unknown,
  legacyLines: readonly InvoiceLine[],
): ChargeLines {
  const read = readChargeSnapshot(stored);
  if (read.state === "snapshot") {
    return { source: "snapshot", lines: invoiceLinesOf(chargeToPriceSnapshot(read.value)) };
  }
  if (read.state === "legacy") return { source: "legacy", lines: [...legacyLines] };
  throw new InvoiceError("invalid_lines");
}

/**
 * The lines of the full-reversal credit note of a charge: the exact lines of the invoice. A credit note
 * reverses the whole charge; a partial one is done by hand with four-eyes approval and is not built.
 */
export function creditNoteLinesOf(
  stored: unknown,
  legacyLines: readonly InvoiceLine[] = [],
): InvoiceLine[] {
  return resolveChargeLines(stored, legacyLines).lines;
}
