// WP7-T4, spec 12: what the platform does with a TLD of the `tlds` table. Pure; fails closed (R16).
// "TLDs that require extra parameters or eligibility proof are listed too, but their orders go to an
// admin review step before RegisterDomain."

/** The columns of a `tlds` row that the policy reads. Prices are numeric text, never numbers (R4). */
export interface TldRow {
  readonly tld: string;
  readonly registrationPriceUsd: string | null;
  readonly renewalPriceUsd: string | null;
  readonly needsExtraParams: boolean;
}

/** `auto`: registered by the provisioner. `review`: an admin approves first. `unavailable`: not sold. */
export type TldDecision = "auto" | "review" | "unavailable";

const PRICE = /^\d{1,8}(\.\d{1,4})?$/;

/**
 * A TLD is sold only with a registration price and a renewal price that parse as plain non-negative
 * decimal text (a name that can be bought but not renewed is a trap). Extra parameters mean review.
 */
export function decideTld(row: TldRow): TldDecision {
  if (row.registrationPriceUsd === null || !PRICE.test(row.registrationPriceUsd)) {
    return "unavailable";
  }
  if (row.renewalPriceUsd === null || !PRICE.test(row.renewalPriceUsd)) return "unavailable";
  return row.needsExtraParams ? "review" : "auto";
}

export function tldPolicyOf(
  rows: readonly TldRow[],
): { readonly tld: string; readonly decision: TldDecision }[] {
  return rows.map((row) => ({ tld: row.tld, decision: decideTld(row) }));
}
