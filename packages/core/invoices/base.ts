// Invoices and receipts (9.3): pure logic. No AWS, no HTTP, no database. Money is bigint paisa (R4):
// there is no float anywhere in this folder.
import type { Locale, Minor } from "../types";

export type InvoiceErrorCode =
  "invalid_number" | "invalid_date" | "invalid_amount" | "invalid_lines" | "seller_details_missing";

// Fixed text: a message never holds the value it refused (R14).
export class InvoiceError extends Error {
  constructor(readonly code: InvoiceErrorCode) {
    super(`invoice: ${code}`);
    this.name = "InvoiceError";
  }
}

// Fiscal year: the first calendar year of July to June, by the calendar of Dhaka (UTC+6, no DST).
export function fiscalYearOf(at: Date): number {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new InvoiceError("invalid_date");
  const dhaka = new Date(at.getTime() + 6 * 3_600_000);
  const year = dhaka.getUTCFullYear();
  return dhaka.getUTCMonth() >= 6 ? year : year - 1;
}

// Latin digits always (16.13: invoice numbers are technical values).
export function formatInvoiceNumber(fiscalYear: number, number: number): string {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2026) throw new InvoiceError("invalid_number");
  if (!Number.isInteger(number) || number < 1 || number > 999_999) {
    throw new InvoiceError("invalid_number");
  }
  return `TC-${fiscalYear}-${String(number).padStart(6, "0")}`;
}

export type Numerals = "beng" | "latn";
const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

// The exact amount with two decimals, from integer paisa. Digits follow the market setting: Bengali
// by default in bn, Latin in en.
export function formatMinor(amount: Minor, locale: Locale, numerals?: Numerals): string {
  if (typeof amount !== "bigint" || amount < 0n) throw new InvoiceError("invalid_amount");
  const whole = (amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${whole}.${(amount % 100n).toString().padStart(2, "0")}`;
  const useBengali = (numerals ?? (locale === "bn" ? "beng" : "latn")) === "beng";
  return useBengali ? text.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] ?? d) : text;
}

export type Text2 = Record<Locale, string>;

// A line as it is stored in invoices.lines (jsonb has no bigint: the amount is a decimal string).
export interface InvoiceLine {
  kind: "service" | "step";
  code: string;
  label: Text2;
  amountMinor: string;
  /** The rate of a VAT step as decimal text ("0.05"), stored with the line. Never computed here. */
  rate?: string;
}

export function parseLineAmount(text: unknown): Minor {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(text)) {
    throw new InvoiceError("invalid_amount");
  }
  return BigInt(text);
}

export interface InvoiceLinesInput {
  baseMinor: Minor;
  steps: readonly { code: string; amountMinor: Minor; rate?: string }[];
  totalMinor: Minor;
  labels: { aws: Text2; steps: Readonly<Record<string, Text2>> };
}

// One line for the AWS service price, then one per pricing step whose amount is not 0 (9.3). The lines
// must add up to the total of the order; if they do not, nothing is issued (R16).
export function buildInvoiceLines(input: InvoiceLinesInput): InvoiceLine[] {
  const lines: InvoiceLine[] = [
    {
      kind: "service",
      code: "aws",
      label: input.labels.aws,
      amountMinor: input.baseMinor.toString(),
    },
  ];
  let sum = input.baseMinor;
  for (const step of input.steps) {
    if (step.amountMinor < 0n) throw new InvoiceError("invalid_amount");
    if (step.amountMinor === 0n) continue;
    const label = input.labels.steps[step.code];
    if (label === undefined) throw new InvoiceError("invalid_lines");
    lines.push({
      kind: "step",
      code: step.code,
      label,
      amountMinor: step.amountMinor.toString(),
      ...(step.rate !== undefined ? { rate: step.rate } : {}),
    });
    sum += step.amountMinor;
  }
  if (input.baseMinor < 0n || sum !== input.totalMinor) throw new InvoiceError("invalid_lines");
  return lines;
}

const KEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The object key of a rendered PDF in the invoices bucket. Derived, never typed by a customer: both
// ids must be UUIDs, the locale one of the two. The web app and invoice-renderer share this rule, so
// the page can find the object without a stored key.
export function invoicePdfKey(customerId: string, invoiceId: string, locale: Locale): string {
  if (
    !KEY_UUID.test(customerId) ||
    !KEY_UUID.test(invoiceId) ||
    (locale !== "bn" && locale !== "en")
  ) {
    throw new InvoiceError("invalid_number");
  }
  return `invoices/${customerId}/${invoiceId}.${locale}.pdf`;
}
