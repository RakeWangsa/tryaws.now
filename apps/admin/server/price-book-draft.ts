import type { BookTerms } from "@tc/core";
import { startOf, type Getter } from "./pricing-draft.ts";

// The draft of a price list entry as the editor sends it: plain text fields, a GET form for the preview
// and the same fields as hidden inputs in the save form (as pricing-draft.ts). The admin types a margin
// in percent ("15" or "12.5"); the engine keeps a fraction ("0.15") or whole paisa for each unit. The
// conversion is done on the digits of the text, never on a number (R4).

export { startOf };

export interface BookDraft {
  readonly market: string;
  readonly family: string;
  readonly marginKind: string;
  readonly margin: string;
  readonly commissionKind: string;
  readonly commission: string;
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: string;
}

const MARKET = /^[A-Z]{2}$/;
const FAMILY = /^[a-z][a-z_]{0,39}$/;
const PERCENT_INPUT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
const FRACTION = /^(\d+)(?:\.(\d+))?$/;
const PAISA = /^(0|[1-9]\d{0,8})$/;

const clean = (value: string, max: number): string => value.trim().slice(0, max);

export function readBookDraft(get: Getter, fallbackMarket: string): BookDraft {
  const market = MARKET.test(get("market").trim()) ? get("market").trim() : fallbackMarket;
  const family = FAMILY.test(get("family").trim()) ? get("family").trim() : "";
  return {
    market,
    family,
    marginKind: clean(get("marginKind"), 10) || "percent",
    margin: clean(get("margin"), 12),
    commissionKind: clean(get("commissionKind"), 10) || "none",
    commission: clean(get("commission"), 12),
    from: clean(get("from"), 16),
  };
}

/** "12.5" (percent) to "0.125" (the fraction of the engine); null when the text is not at most 3 digits and 2 decimals. */
export function percentToFraction(percent: string): string | null {
  const m = PERCENT_INPUT.exec(percent);
  if (m === null) return null;
  // percent * 100 as a whole number is the fraction * 10000
  const units = BigInt(`${m[1]}${(m[2] ?? "").padEnd(2, "0")}`);
  const whole = units / 10000n;
  const fraction = (units % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** "0.125" to "12.5"; the text unchanged when it is not a fraction with at most 4 decimals. */
export function fractionToPercent(fraction: string): string {
  const m = FRACTION.exec(fraction);
  if (m === null || (m[2] ?? "").length > 4) return fraction;
  const units = BigInt(`${m[1]}${(m[2] ?? "").padEnd(4, "0")}`); // fraction * 10000 = percent * 100
  const whole = units / 100n;
  const rest = (units % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return rest === "" ? whole.toString() : `${whole.toString()}.${rest}`;
}

type Amount = { kind: "percent" | "fixed"; value: string };

function amountOf(kind: string, text: string): Amount | null {
  if (kind === "percent") {
    const fraction = percentToFraction(text);
    return fraction === null ? null : { kind, value: fraction };
  }
  return PAISA.test(text) ? { kind: "fixed", value: text } : null;
}

export type DraftTerms =
  | { readonly ok: true; readonly terms: BookTerms }
  | { readonly ok: false; readonly fields: readonly string[] };

/** The terms of the draft, or the names of the fields to correct. Whether the engine accepts them is its call. */
export function termsOfDraft(draft: BookDraft): DraftTerms {
  const bad: string[] = [];
  if (draft.marginKind !== "percent" && draft.marginKind !== "fixed") bad.push("marginKind");
  else if (amountOf(draft.marginKind, draft.margin) === null) bad.push("margin");
  const none = draft.commissionKind === "none";
  if (!none && draft.commissionKind !== "percent" && draft.commissionKind !== "fixed") {
    bad.push("commissionKind");
  } else if (!none && amountOf(draft.commissionKind, draft.commission) === null) {
    bad.push("commission");
  }
  if (bad.length > 0) return { ok: false, fields: bad };
  const margin = amountOf(draft.marginKind, draft.margin);
  const commission = none ? null : amountOf(draft.commissionKind, draft.commission);
  if (margin === null || (!none && commission === null)) return { ok: false, fields: ["margin"] };
  return { ok: true, terms: { margin, commission } };
}
