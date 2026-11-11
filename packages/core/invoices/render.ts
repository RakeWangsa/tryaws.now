// The invoice HTML (9.3). One template for the invoice page and for the PDF of invoice-renderer. The
// CSS is inlined in one <style> element and the document refers to no URL (3: the renderer has no
// network); the fonts are packaged with the function and named in font-family, never fetched (U4
// exception for the invoice). Pure: the same input gives the same text.
import type { Locale, Minor } from "../types";
import {
  InvoiceError,
  formatMinor,
  parseLineAmount,
  type InvoiceLine,
  type Numerals,
} from "./base";

export type DocumentKind = "invoice" | "receipt";

export interface InvoiceDocument {
  kind: DocumentKind;
  number: string;
  issuedAt: Date;
  company: { name: string; address: readonly string[] };
  customer: { name: string | null; address?: string | null };
  lines: readonly InvoiceLine[];
  totalMinor: Minor;
  numerals?: Numerals;
}

// 16.13, unchanged.
const SHORT_STATEMENT: Record<Locale, string> = {
  en: "100% AWS infrastructure. Built on Amazon Lightsail.",
  bn: "১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।",
};
const TRADEMARK_LINE =
  "Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates.";
// Who sells, bills and supports (no implied endorsement, 16.13).
const SELLER_LINE: Record<Locale, string> = {
  en: "TiCON Cloud sells, bills and supports the service.",
  bn: "বিক্রি, বিল ও সাপোর্ট TiCON Cloud দেয়।",
};

const TEXT = {
  en: {
    invoice: "Invoice",
    receipt: "Payment receipt",
    notTax: "This is a payment receipt, not a tax invoice.",
    number: "Number",
    date: "Date",
    billedTo: "Billed to",
    description: "Description",
    amount: "Amount (BDT)",
    total: "Total (BDT)",
  },
  bn: {
    invoice: "ইনভয়েস",
    receipt: "পেমেন্ট রসিদ",
    notTax: "এটি পেমেন্ট রসিদ, ট্যাক্স ইনভয়েস নয়।",
    number: "নম্বর",
    date: "তারিখ",
    billedTo: "গ্রাহক",
    description: "বিবরণ",
    amount: "টাকা (BDT)",
    total: "মোট (BDT)",
  },
} as const;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
// Every string that is not a constant of this file goes through here (R11).
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
function dateText(at: Date, locale: Locale, numerals: Numerals | undefined): string {
  const dhaka = new Date(at.getTime() + 6 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const text = `${p(dhaka.getUTCDate())}-${p(dhaka.getUTCMonth() + 1)}-${dhaka.getUTCFullYear()}`;
  const bengali = (numerals ?? (locale === "bn" ? "beng" : "latn")) === "beng";
  return bengali ? text.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] ?? d) : text;
}

// The font names are packaged with the function (VERIFY: Bengali shaping in the PDF engine).
const CSS = `
body{font-family:"Noto Sans Bengali","Noto Sans",sans-serif;color:#1b1f23;font-size:13px;line-height:1.5;margin:0;padding:32px}
header{display:flex;justify-content:space-between;border-bottom:2px solid #1b1f23;padding-bottom:12px}
h1{font-size:22px;margin:0}
.brand{font-size:20px;font-weight:700}
table{width:100%;border-collapse:collapse;margin-top:20px}
th,td{padding:8px;border-bottom:1px solid #d0d4d9;text-align:left}
th.num,td.num{text-align:right;white-space:nowrap}
tfoot td{font-weight:700;border-top:2px solid #1b1f23;border-bottom:0}
.meta{margin-top:16px;display:flex;justify-content:space-between}
.note{margin-top:16px}
footer{margin-top:32px;border-top:1px solid #d0d4d9;padding-top:12px;font-size:11px;color:#4a5159}
`.trim();

export function renderInvoiceHtml(doc: InvoiceDocument, locale: Locale): string {
  const t = TEXT[locale];
  let sum = 0n;
  const rows = doc.lines.map((line) => {
    const amount = parseLineAmount(line.amountMinor);
    sum += amount;
    return `<tr><td>${escapeHtml(line.label[locale])}</td><td class="num">${formatMinor(amount, locale, doc.numerals)}</td></tr>`;
  });
  // The page never prints a total that its lines do not add up to (R16).
  if (doc.lines.length === 0 || sum !== doc.totalMinor) throw new InvoiceError("invalid_lines");

  const title = doc.kind === "receipt" ? t.receipt : t.invoice;
  const company = [doc.company.name, ...doc.company.address].map(escapeHtml).join("<br>");
  const customer = [doc.customer.name ?? "", doc.customer.address ?? ""]
    .filter((s) => s !== "")
    .map(escapeHtml)
    .join("<br>");

  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    `<head><meta charset="utf-8"><title>${escapeHtml(title)} ${escapeHtml(doc.number)}</title><style>${CSS}</style></head>`,
    "<body>",
    `<header><div><div class="brand">${escapeHtml(doc.company.name)}</div><div>${company}</div></div>`,
    `<div><h1>${escapeHtml(title)}</h1></div></header>`,
    `<div class="meta"><div><strong>${t.billedTo}</strong><br>${customer}</div>`,
    `<div><strong>${t.number}</strong> ${escapeHtml(doc.number)}<br><strong>${t.date}</strong> ${dateText(doc.issuedAt, locale, doc.numerals)}</div></div>`,
    `<table><thead><tr><th>${t.description}</th><th class="num">${t.amount}</th></tr></thead>`,
    `<tbody>${rows.join("")}</tbody>`,
    `<tfoot><tr><td>${t.total}</td><td class="num">${formatMinor(doc.totalMinor, locale, doc.numerals)}</td></tr></tfoot></table>`,
    doc.kind === "receipt" ? `<p class="note">${t.notTax}</p>` : "",
    `<footer><p>${SHORT_STATEMENT[locale]} ${SELLER_LINE[locale]}</p><p>${TRADEMARK_LINE}</p></footer>`,
    "</body></html>",
  ].join("\n");
}
