// WPU-I5: the one rule for the length of the texts of a buyer snapshot (the buyer of a Mushak 6.3). It lives
// here, the lowest layer, because packages/core/invoices (which makes the snapshot) imports @tc/db and the
// db check (invoices.issue) must apply the very same function. Length is counted in code points, what the
// customer sees, not in UTF-16 units; the snapshot parser of the core and the db check agree by design.
export const BUYER_NAME_MAX = 120;
export const BUYER_ADDRESS_MAX = 300;

export function buyerTextLength(text: string): number {
  return Array.from(text).length;
}

/** Cuts to `max` code points; never splits a surrogate pair. Used only for the FALLBACK profile name. */
export function truncateBuyerText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}
