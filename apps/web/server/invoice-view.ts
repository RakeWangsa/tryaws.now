import type { CustomerSession } from "@tc/auth";
import {
  formatInvoiceNumber,
  parseLineAmount,
  type InvoiceDocument,
  type InvoiceLine,
  type Numerals,
} from "@tc/core";
import { customerRepos, withTx } from "@tc/db";
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
}

export interface InvoiceDetailView {
  id: string;
  number: string;
  issuedAt: Date;
  totalMinor: bigint;
  lines: InvoiceLineView[];
}

export type InvoiceDetailScreen =
  { state: "ready"; invoice: InvoiceDetailView } | { state: "unavailable" };

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
    out.push({
      kind: line["kind"],
      code: line["code"],
      label: { bn: line["label"].bn, en: line["label"].en },
      amountMinor: amount,
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
  const row = await withTx((tx) => customerRepos(tx, session.customerId).invoices.get(id));
  if (row === null) return null;
  const lines = parseStoredLines(row.lines, row.totalMinor);
  if (lines === null) return { state: "unavailable" };
  return {
    state: "ready",
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
 * The document of the core for the printable page. The seller's legal name and address are not defined
 * yet (JOURNEY, WPU-G4, Needs decision): only the trade name is printed.
 */
export function toInvoiceDocument(
  invoice: InvoiceDetailView,
  customerName: string,
  numerals: Numerals,
): InvoiceDocument {
  const lines: InvoiceLine[] = invoice.lines.map((l) => ({
    kind: l.kind,
    code: l.code,
    label: l.label,
    amountMinor: l.amountMinor.toString(),
  }));
  return {
    kind: "invoice",
    number: invoice.number,
    issuedAt: invoice.issuedAt,
    company: { name: "TiCON Cloud", address: [] },
    customer: { name: customerName === "" ? null : customerName },
    lines,
    totalMinor: invoice.totalMinor,
    numerals,
  };
}
