// The seller of a tax invoice (Mushak 6.3): legal name, BIN and address, which the owner enters in the
// admin panel (settings key `invoice_seller`). Pure. Nothing here is invented or defaulted: a row that is
// missing or that does not parse gives null, and an invoice is not issued or printed without it (R16).

export const SELLER_SETTING_KEY = "invoice_seller";

export interface SellerDetails {
  legalNameBn: string;
  legalNameEn: string;
  /** 13 Latin digits. */
  bin: string;
  addressBn: string;
  addressEn: string;
  signatoryName: string;
  signatoryDesignation: string;
  /** VAT circle / commissionerate, optional. */
  vatCircle?: string;
  phone?: string;
  email?: string;
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

export function isValidBin(value: unknown): value is string {
  return typeof value === "string" && BIN.test(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "" || t.length > max || CONTROL.test(t)) return null;
  return t;
}

/** The row as the document uses it, or null when anything is missing or malformed (R16). */
export function parseSellerDetails(value: unknown): SellerDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, max] of REQUIRED) {
    const t = text(raw[key], max);
    if (t === null) return null;
    out[key] = t;
  }
  if (!isValidBin(raw["bin"])) return null;
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
  return out as unknown as SellerDetails;
}

/** Only the known fields, for storing. */
export function sellerValueOf(seller: SellerDetails): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key] of REQUIRED) out[key] = seller[key];
  out["bin"] = seller.bin;
  for (const [key] of OPTIONAL) {
    const v = seller[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
