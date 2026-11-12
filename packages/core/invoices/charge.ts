import { createHash } from "node:crypto";
import { customerRepos, type Tx } from "@tc/db";
import type { Logger } from "../operations/types";
import type { PriceSnapshot } from "../pricing/snapshot";
import { buyerSnapshotFrom, type BuyerSnapshot } from "./buyer";
import { buildInvoiceLines, fiscalYearOf, type InvoiceLine, type Text2 } from "./base";

// WPU-I2: the tax invoice of a paid charge. Spec 9.3: each purchase and each renewal creates an invoice
// (a wallet top-up makes a payment receipt, not an invoice). The invoice is issued in the transaction of
// the charge, so a rollback of the charge frees its number (gap-free numbering per fiscal year). But the
// invoice never stands in the way of the money:
//   - without complete seller details (`seller_details_missing`) the charge goes through, the invoice is
//     queued with its lines and the admin queue gets a notice; the scheduler issues it later
//     (backlog.ts), in the order of the charge;
//   - any other trouble in the issue is rolled back to a savepoint and the invoice is queued as well.
// R7: the id of the invoice is derived from the ledger transaction and the invoice row is unique on that
// transaction, so the second call for the same charge is a replay. R16: nothing is guessed; a charge
// whose invoice could not be issued or queued is reported as `failed` and the caller carries on.

export const INVOICE_AWS_LABEL: Text2 = Object.freeze({
  bn: "Amazon Web Services (AWS) সেবার মূল্য",
  en: "Amazon Web Services (AWS) service price",
});

// The names of the pricing steps on the invoice: the labels of the launch rule (packages/db/seed).
export const INVOICE_STEP_LABELS: Readonly<Record<string, Text2>> = Object.freeze({
  korea_vat: Object.freeze({ bn: "কোরিয়ার VAT", en: "Korea VAT" }),
  bd_vat: Object.freeze({ bn: "বাংলাদেশের VAT", en: "Bangladesh VAT" }),
  processing_fee: Object.freeze({ bn: "প্রসেসিং ফি", en: "Processing fee" }),
  markup: Object.freeze({ bn: "সার্ভিস চার্জ", en: "Service charge" }),
});

/** The stored lines of a charge, from the snapshot that priced it. The rate travels with its step. */
export function invoiceLinesOf(snapshot: PriceSnapshot): InvoiceLine[] {
  return buildInvoiceLines({
    baseMinor: BigInt(snapshot.baseMinor),
    steps: snapshot.steps.map((s) => ({
      code: s.code,
      amountMinor: BigInt(s.amountMinor),
      ...(s.rate === undefined ? {} : { rate: s.rate }),
    })),
    totalMinor: BigInt(snapshot.totalMinor),
    labels: { aws: INVOICE_AWS_LABEL, steps: INVOICE_STEP_LABELS },
  });
}

/** The invoice id of a charge: the same charge always gives the same id (R7). A UUID of version 5 form. */
export function invoiceIdFor(ledgerTransactionId: string): string {
  const bytes = createHash("sha256")
    .update(`invoice|${ledgerTransactionId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of the queue entry of a charge. */
export function queueIdFor(ledgerTransactionId: string): string {
  return invoiceIdFor(`queue|${ledgerTransactionId}`);
}

/** The id of the notice for a charge that could not be queued with its lines (WPU-I5). */
export function noteIdFor(ledgerTransactionId: string): string {
  return invoiceIdFor(`note|${ledgerTransactionId}`);
}

export interface ChargeInvoiceInput {
  readonly customerId: string;
  /** The charge: a purchase names its order, a renewal has none. */
  readonly charge:
    { readonly kind: "order"; readonly orderId: string } | { readonly kind: "renewal" };
  /** The ledger transaction that took the money. */
  readonly ledgerTransactionId: string;
  /** The snapshot that priced the charge (its total is the wallet debit). */
  readonly snapshot: PriceSnapshot;
  /** The instant of the charge. The fiscal year and the date of issue of the invoice both come from it. */
  readonly now: Date;
  /** WPU-I5: where a charge that ends without an invoice and without a queue row is reported (ids only). */
  readonly log?: Logger;
}

/**
 * WPU-I4: the buyer of an invoice about to be issued: the customer's billing profile read in the
 * transaction of the issue, with the profile name as the fallback (buyerSnapshotFrom). null when the
 * customer entered nothing, or the profile cannot be read: the invoice then prints "-" (R16).
 */
export async function readBuyerSnapshot(tx: Tx, customerId: string): Promise<BuyerSnapshot | null> {
  const source = await customerRepos(tx, customerId).profile.getBuyerSource();
  return source === null ? null : buyerSnapshotFrom(source.billing, source.name);
}

/**
 * issued, replayed: the invoice exists. queued: owed, stored with its lines. noted: owed, stored as a
 * notice with ids only (the lines could not be built or queued); a person looks at it and the scheduler's
 * reconciliation may still queue an order. reversed: the charge was reversed, nothing is owed. failed:
 * nothing could be written either; a structured error is logged and the scheduler's reconciliation finds
 * the charge (WPU-I5). The caller counts "noted" and "failed" in its metrics.
 */
export type ChargeInvoiceOutcome =
  "issued" | "replayed" | "queued" | "noted" | "reversed" | "failed";

/**
 * Issues the invoice of a charge inside the caller's transaction, or queues it. Never throws and never
 * refuses the charge: a failing statement is rolled back to a savepoint of its own.
 */
export async function issueChargeInvoice(
  tx: Tx,
  input: ChargeInvoiceInput,
): Promise<ChargeInvoiceOutcome> {
  const unrecorded = async (outcome: "noted" | "failed"): Promise<ChargeInvoiceOutcome> => {
    // Ids and fixed words only (R14).
    input.log?.({
      event: "invoice_charge_unrecorded",
      outcome,
      charge: input.charge.kind,
      ledgerTransactionId: input.ledgerTransactionId,
    });
    return outcome;
  };
  // The notice without lines: the charge is not lost even when the lines cannot be built or stored.
  const note = async (): Promise<ChargeInvoiceOutcome> => {
    try {
      const noted = await tx.transaction(async (sp) =>
        customerRepos(sp, input.customerId).invoices.noteUnrecorded({
          id: noteIdFor(input.ledgerTransactionId),
          kind: input.charge.kind,
          ...(input.charge.kind === "order" ? { orderId: input.charge.orderId } : {}),
          ledgerTransactionId: input.ledgerTransactionId,
          totalMinor: BigInt(input.snapshot.totalMinor),
        }),
      );
      return unrecorded(noted.ok ? "noted" : "failed");
    } catch {
      return unrecorded("failed");
    }
  };

  let lines: InvoiceLine[];
  let totalMinor: bigint;
  let fiscalYear: number;
  try {
    lines = invoiceLinesOf(input.snapshot);
    totalMinor = BigInt(input.snapshot.totalMinor);
    // One instant: the same `now` gives the fiscal year here and the date of issue below.
    fiscalYear = fiscalYearOf(input.now);
  } catch {
    return note();
  }
  const id = invoiceIdFor(input.ledgerTransactionId);

  type Attempt = "issued" | "replayed" | "missing" | "refused" | "reversed" | "blocked";
  let attempt: Attempt;
  try {
    attempt = await tx.transaction(async (sp): Promise<Attempt> => {
      const invoices = customerRepos(sp, input.customerId).invoices;
      // An older charge of this market still waits for its invoice: this one waits behind it, so the
      // numbers follow the order of the charge (WPU-I5). If that cannot be known, it waits too (R16).
      if (await invoices.backlogBlocked()) return "blocked";
      // The billing profile as it is now, in this transaction: it is frozen on the invoice (WPU-I3).
      const buyer = await readBuyerSnapshot(sp, input.customerId);
      const written =
        input.charge.kind === "order"
          ? await invoices.issue({
              id,
              orderId: input.charge.orderId,
              fiscalYear,
              issuedAt: input.now,
              lines,
              totalMinor,
              buyer,
            })
          : await invoices.issueForCharge({
              id,
              ledgerTransactionId: input.ledgerTransactionId,
              fiscalYear,
              issuedAt: input.now,
              lines,
              totalMinor,
              buyer,
            });
      if (written.ok) return written.replayed ? "replayed" : "issued";
      if (written.error === "charge_reversed") return "reversed";
      return written.error === "seller_details_missing" ? "missing" : "refused";
    });
  } catch {
    // The statement failed (it is rolled back to the savepoint); the invoice is owed all the same.
    attempt = "refused";
  }
  if (attempt === "issued" || attempt === "replayed") return attempt;
  if (attempt === "reversed") return "reversed";

  // Owed: store the charge with its lines. A refusal for another reason than the missing seller is
  // queued too; the scheduler tries again and a person sees the notice.
  try {
    const queued = await tx.transaction(async (sp) =>
      customerRepos(sp, input.customerId).invoices.queueBacklog({
        id: queueIdFor(input.ledgerTransactionId),
        kind: input.charge.kind,
        ...(input.charge.kind === "order" ? { orderId: input.charge.orderId } : {}),
        ledgerTransactionId: input.ledgerTransactionId,
        lines,
        totalMinor,
      }),
    );
    if (queued.ok) return "queued";
  } catch {
    // fall through to the notice
  }
  return note();
}
