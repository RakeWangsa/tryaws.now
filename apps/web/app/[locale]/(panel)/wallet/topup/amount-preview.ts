// The amount line of the top-up form, while the customer types. This is a PREVIEW for the eyes only:
// the Server Action reads the text again with parseTopUpAmount of @tc/core (R4, R9), and what it
// accepts is what is charged. The preview is a copy of that grammar because a Client Component cannot
// import the barrel of @tc/core (it pulls the database driver into the browser bundle; seen in
// `next build`). amount-preview.test.ts compares the two on a table, so a drift fails a test.

export interface PreviewRange {
  readonly minMinor: bigint;
  readonly maxMinor: bigint;
}

const BENGALI_ZERO = 0x09e6;

/** Whole taka in ASCII or Bengali digits, grouped with commas or spaces, as paisa; null when the server would refuse it. */
export function previewAmount(text: string, range: PreviewRange): bigint | null {
  let digits = "";
  for (const ch of text.trim()) {
    if (ch === "," || ch === " " || ch === " ") continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (cp >= BENGALI_ZERO && cp <= BENGALI_ZERO + 9)
      digits += String.fromCharCode(48 + cp - BENGALI_ZERO);
    else return null;
  }
  if (!/^[0-9]{1,9}$/.test(digits)) return null;
  const minor = BigInt(digits) * 100n;
  return minor < range.minMinor || minor > range.maxMinor ? null : minor;
}
