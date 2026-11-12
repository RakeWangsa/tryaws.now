import { and, eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { settings } from "../../schema/index";
import { isMarketCode } from "./args";

// The seller of the tax invoices (WPU-I1, Mushak 6.3): legal name, BIN, address and signatory, entered by
// the owner in the admin panel. One row of `settings`, key `invoice_seller`, scope 'market', value
//
//   { "v": 1, "version": <1,2,3...>, "legalNameBn": "...", "legalNameEn": "...", "bin": "<13 digits>",
//     "addressBn": "...", "addressEn": "...", "signatoryName": "...", "signatoryDesignation": "...",
//     "vatCircle"?: "...", "phone"?: "...", "email"?: "..." }
//
// `version` counts the saves (the older values stay in the audit log with before and after). Nothing is
// seeded and nothing is defaulted: no row, or a row that does not parse, means an invoice is not issued
// and not printed (R16). The same rules as parseSellerDetails of @tc/core, which @tc/db cannot import;
// a test of the admin app compares the two. Written only by adminRepos.invoiceSeller.save (audited);
// read by the panel (web_rw) and the functions (worker_rw), which have SELECT on these columns.

export const INVOICE_SELLER_KEY = "invoice_seller";
export const INVOICE_SELLER_VERSION = 1;

export interface SellerRow {
  readonly legalNameBn: string;
  readonly legalNameEn: string;
  readonly bin: string;
  readonly addressBn: string;
  readonly addressEn: string;
  readonly signatoryName: string;
  readonly signatoryDesignation: string;
  readonly vatCircle?: string;
  readonly phone?: string;
  readonly email?: string;
}

const REQUIRED = [
  ["legalNameBn", 200],
  ["legalNameEn", 200],
  ["addressBn", 400],
  ["addressEn", 400],
  ["signatoryName", 120],
  ["signatoryDesignation", 120],
] as const;
const OPTIONAL = [
  ["vatCircle", 200],
  ["phone", 20],
  ["email", 120],
] as const;
const BIN = /^[0-9]{13}$/;
const PHONE = /^[+0-9][0-9 ()-]{5,19}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" || t.length > max || CONTROL.test(t) ? null : t;
}

/** The seller fields of a value (stored or entered), or null when anything is missing or wrong. */
export function parseSellerFields(value: unknown): SellerRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, max] of REQUIRED) {
    const t = text(raw[key], max);
    if (t === null) return null;
    out[key] = t;
  }
  if (typeof raw["bin"] !== "string" || !BIN.test(raw["bin"])) return null;
  out["bin"] = raw["bin"];
  for (const [key, max] of OPTIONAL) {
    const given = raw[key];
    if (given === undefined || given === null || given === "") continue;
    const t = text(given, max);
    if (t === null) return null;
    if (key === "phone" && !PHONE.test(t)) return null;
    if (key === "email" && !EMAIL.test(t)) return null;
    out[key] = t;
  }
  return out as unknown as SellerRow;
}

/** A stored row: version 1 of the shape and a positive save counter. */
export function parseSellerRowValue(value: unknown): { seller: SellerRow; version: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw["v"] !== INVOICE_SELLER_VERSION) return null;
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  const seller = parseSellerFields(raw);
  return seller === null ? null : { seller, version };
}

export function sellerRowValueOf(seller: SellerRow, version: number): Record<string, unknown> {
  const out: Record<string, unknown> = { v: INVOICE_SELLER_VERSION, version };
  for (const [key] of REQUIRED) out[key] = seller[key];
  out["bin"] = seller.bin;
  for (const [key] of OPTIONAL) {
    const v = seller[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export type SellerRead =
  | { readonly state: "none" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly seller: SellerRow; readonly version: number };

/** The seller of a market. `none` and `invalid` both mean: do not issue (R16). Not tenant data. */
export async function readInvoiceSeller(tx: Tx, market: string): Promise<SellerRead> {
  if (!isMarketCode(market)) throw new TypeError("readInvoiceSeller: market is invalid");
  const rows = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, INVOICE_SELLER_KEY),
        eq(settings.market, market),
        eq(settings.scope, "market"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { state: "none" };
  const parsed = parseSellerRowValue(row.value);
  return parsed === null ? { state: "invalid" } : { state: "ok", ...parsed };
}
