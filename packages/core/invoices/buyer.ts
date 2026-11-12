// The buyer of a tax invoice (Mushak 6.3), as it is stored on the invoice the day it is issued
// (WPU-I3). The customer's billing profile is copied into the invoice row at issue time, so a reprint
// shows what the invoice said that day, whatever the customer changes later. Pure. The values are
// personal or business identifiers: they are never logged (R14); malformed stored data gives null and
// the invoice then prints "-" (R16), never a guess.

import {
  BUYER_ADDRESS_MAX,
  BUYER_NAME_MAX,
  buyerTextLength,
  truncateBuyerText,
} from "@tc/db/buyer-rules";

export interface BuyerSnapshot {
  name: string | null;
  address: string | null;
  /** The BIN (13 digits) of a registered business, or null. There is no NID (WPU-D3). */
  taxId: { kind: "bin"; value: string } | null;
}

/** The fields of the customer's billing profile that the snapshot is made from. */
export interface BillingFields {
  billingName: string | null;
  billingAddress: string | null;
  customerBin: string | null;
}

// WPU-I5: the limits and the way a length is counted are one rule, in @tc/db (the db check uses it too).
const NAME_MAX = BUYER_NAME_MAX;
const ADDRESS_MAX = BUYER_ADDRESS_MAX;

/**
 * null when the profile holds no billing detail at all: nothing is stored, the invoice prints "-".
 * The billing name defaults to the profile name (`fallbackName`) so the snapshot freezes the name that
 * the invoice prints.
 */
export function buyerSnapshotFrom(
  profile: BillingFields,
  fallbackName: string | null = null,
): BuyerSnapshot | null {
  const taxId =
    profile.customerBin !== null ? ({ kind: "bin", value: profile.customerBin } as const) : null;
  if (profile.billingName === null && profile.billingAddress === null && taxId === null) {
    return null;
  }
  // The fallback (the sign-up name, up to 200 characters) is cut to the limit of the snapshot; a name the
  // customer typed in the billing details was validated on input and is never cut.
  const name =
    profile.billingName ??
    (fallbackName === null ? null : truncateBuyerText(fallbackName, NAME_MAX));
  return { name, address: profile.billingAddress, taxId };
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "" || buyerTextLength(value) > max) return undefined;
  return value;
}

/**
 * The stored snapshot, or null when it is missing or malformed. Unknown keys are dropped. A snapshot
 * issued before WPU-D3 may hold a NID as its tax id: it is accepted (the invoice stays readable) but the
 * number is never returned or printed, the tax id becomes null.
 */
export function parseBuyerSnapshot(value: unknown): BuyerSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = optionalText(raw["name"], NAME_MAX);
  const address = optionalText(raw["address"], ADDRESS_MAX);
  if (name === undefined || address === undefined) return null;
  let taxId: BuyerSnapshot["taxId"] = null;
  const given = raw["taxId"];
  if (given !== undefined && given !== null) {
    if (typeof given !== "object" || Array.isArray(given)) return null;
    const t = given as Record<string, unknown>;
    const v = t["value"];
    if (typeof v !== "string" || !/^[0-9]+$/.test(v)) return null;
    if (t["kind"] === "bin" && v.length === 13) taxId = { kind: "bin", value: v };
    else if (t["kind"] === "nid" && [10, 13, 17].includes(v.length)) taxId = null;
    else return null;
  }
  return { name, address, taxId };
}
