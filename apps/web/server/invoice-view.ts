import type { CustomerSession } from "@tc/auth";
import {
  formatInvoiceNumber,
  parseBuyerSnapshot,
  parseLineAmount,
  parseSellerDetails,
  type BuyerSnapshot,
  type InvoiceDocument,
  type InvoiceLine,
  type Numerals,
  type SellerDetails,
} from "@tc/core";
import { customerRepos, readInvoiceSeller, withTx } from "@tc/db";
import type { InvoiceCursor } from "@tc/db";

// What /invoices and /invoices/[id] show (WPU-G4), read through the repositories of the session's
// customer (R8): an invoice of another customer answers like a missing one. A database error is thrown,
// never answered with an empty list (R16). The stored lines are parsed here with the core's rules: lines
// that do not add up to the total are not shown, the page says "not available" instead (R16). Money is
// bigint paisa (R4). The invoice number is the technical value TC-<year>-<number> in Latin digits.

export const INVOICE_PAGE_SIZE = 20;

export interface InvoiceListItem {
  id: string;
  /** TC-2026-000012. */
  number: string;
  issuedAt: Date;
  totalMinor: bigint;
}

export type InvoiceListScreen =
  { state: "empty" } | { state: "ready"; items: InvoiceListItem[]; next: string | null };

export interface InvoiceLineView {
  kind: "service" | "step";
  code: string;
  label: { bn: string; en: string };
  amountMinor: bigint;
  /** The rate of a VAT step as stored with the line ("0.05"). */
  rate?: string;
}

export interface InvoiceDetailView {
  id: string;
  number: string;
  issuedAt: Date;
  totalMinor: bigint;
  lines: InvoiceLineView[];
}

// `seller_missing`: the seller details (legal name, BIN, address) of the tax invoice are not complete in the
// settings. The invoice is not printed without them (R16, WPU-I1); the customer sees "being prepared" and
// the admin panel shows the notice on /pricing/seller.
export type InvoiceDetailScreen =
  // `buyer`: the billing profile as it was stored on the invoice the day it was issued (WPU-I3), or null
  // (none entered, or unreadable): the buyer then prints as before, the profile name and "-".
  | {
      state: "ready";
      invoice: InvoiceDetailView;
      seller: SellerDetails;
      buyer: BuyerSnapshot | null;
    }
  | { state: "unavailable" }
  | { state: "seller_missing" };

const CURSOR = /^([0-9]{4})-([0-9]{1,6})$/;

/** `2026-12` is the invoice number 12 of the fiscal year 2026; anything else is no cursor. */
export function parseInvoiceCursor(raw: unknown): InvoiceCursor | null {
  if (typeof raw !== "string") return null;
  const match = CURSOR.exec(raw);
  if (match === null) return null;
  const fiscalYear = Number(match[1]);
  const number = Number(match[2]);
  if (fiscalYear < 2026 || number < 1 || number > 999_999) return null;
  return { fiscalYear, number };
}

export function formatInvoiceCursor(cursor: InvoiceCursor): string {
  return `${cursor.fiscalYear}-${cursor.number}`;
}

function isText2(value: unknown): value is { bn: string; en: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["bn"] === "string" && typeof v["en"] === "string";
}

/**
 * The stored lines as bigint amounts, or null when they are not lines of the core or do not add up to
 * the total (R16: a page never prints a total that its lines do not add up to).
 */
export function parseStoredLines(lines: unknown, totalMinor: bigint): InvoiceLineView[] | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const out: InvoiceLineView[] = [];
  let sum = 0n;
  for (const raw of lines as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const line = raw as Record<string, unknown>;
    if (line["kind"] !== "service" && line["kind"] !== "step") return null;
    if (typeof line["code"] !== "string" || !isText2(line["label"])) return null;
    let amount: bigint;
    try {
      amount = parseLineAmount(line["amountMinor"]);
    } catch {
      return null;
    }
    sum += amount;
    const rate = line["rate"];
    // A rate that is stored must be decimal text; anything else makes the lines unreadable (R16).
    if (rate !== undefined && (typeof rate !== "string" || !/^\d{1,3}(\.\d{1,6})?$/.test(rate))) {
      return null;
    }
    out.push({
      kind: line["kind"],
      code: line["code"],
      label: { bn: line["label"].bn, en: line["label"].en },
      amountMinor: amount,
      ...(rate !== undefined ? { rate } : {}),
    });
  }
  return sum === totalMinor ? out : null;
}

export async function loadInvoiceList(
  session: CustomerSession,
  rawCursor: string | undefined,
): Promise<InvoiceListScreen> {
  const after = parseInvoiceCursor(rawCursor);
  const page = await withTx((tx) =>
    customerRepos(tx, session.customerId).invoices.list({
      limit: INVOICE_PAGE_SIZE,
      ...(after !== null ? { after } : {}),
    }),
  );
  if (page.items.length === 0) return { state: "empty" };
  return {
    state: "ready",
    items: page.items.map((row) => ({
      id: row.id,
      number: formatInvoiceNumber(row.fiscalYear, row.number),
      issuedAt: row.issuedAt,
      totalMinor: row.totalMinor,
    })),
    next: page.next === null ? null : formatInvoiceCursor(page.next),
  };
}

/** null for a missing invoice and for another customer's invoice alike (R8). */
export async function loadInvoice(
  session: CustomerSession,
  id: string,
): Promise<InvoiceDetailScreen | null> {
  const { row, stored } = await withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const found = await repos.invoices.get(id);
    if (found === null) return { row: null, stored: null };
    // The market of the customer decides which seller details apply.
    const profile = await repos.profile.get();
    if (profile === null) return { row: found, stored: { state: "none" } as const };
    return { row: found, stored: await readInvoiceSeller(tx, profile.market) };
  });
  if (row === null) return null;
  const lines = parseStoredLines(row.lines, row.totalMinor);
  if (lines === null) return { state: "unavailable" };
  // A tax invoice is never printed without complete seller details (R16): both a missing row and a row
  // that does not parse give the same answer.
  const seller = stored?.state === "ok" ? parseSellerDetails(stored.seller) : null;
  if (seller === null) return { state: "seller_missing" };
  return {
    state: "ready",
    seller,
    buyer: parseBuyerSnapshot(row.buyer),
    invoice: {
      id: row.id,
      number: formatInvoiceNumber(row.fiscalYear, row.number),
      issuedAt: row.issuedAt,
      totalMinor: row.totalMinor,
      lines,
    },
  };
}

/**
 * The document of the core for the printable page: the Mushak 6.3 tax invoice. The seller is the legal
 * entity of the settings (WPU-I1). The buyer is the snapshot of the customer's billing profile stored on
 * the invoice at issue time (WPU-I3: name, address, BIN or NID); without one the buyer is the customer's
 * name and the address and BIN or NID print as "-", nothing is invented. The VAT rate of a line, when stored, travels with the line (never recomputed).
 */
export function toInvoiceDocument(
  invoice: InvoiceDetailView,
  customerName: string,
  numerals: Numerals,
  seller: SellerDetails,
  buyer: BuyerSnapshot | null = null,
): InvoiceDocument {
  const lines: InvoiceLine[] = invoice.lines.map((l) => ({
    kind: l.kind,
    code: l.code,
    label: l.label,
    amountMinor: l.amountMinor.toString(),
    ...(l.rate !== undefined ? { rate: l.rate } : {}),
  }));
  return {
    kind: "invoice",
    number: invoice.number,
    issuedAt: invoice.issuedAt,
    company: { name: seller.legalNameEn, address: [] },
    seller,
    customer: {
      // The stored snapshot, never the live profile: a reprint says what the invoice said that day.
      name: buyer?.name ?? (customerName === "" ? null : customerName),
      address: buyer?.address ?? null,
      taxId: buyer?.taxId ?? null,
    },
    lines,
    totalMinor: invoice.totalMinor,
    numerals,
  };
}
