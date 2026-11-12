// WPU-G10. Whether a plan can run an image, for the wizard. The same rule as planFitsImage of @tc/core
// (a client component cannot import the core, which reaches the database package); a test compares the two.
// A minimum of 0 fits every plan; a plan whose power is unknown does not fit an image with a minimum.
// The server decides again when the draft is made and when the order is placed (R9, R16).
export function planFits(minPower: number | undefined, power: number | null | undefined): boolean {
  const min = minPower ?? 0;
  if (min <= 0) return true;
  return typeof power === "number" && power >= min;
}
