const BENGALI_ZERO = 0x09e6;

/** U+09E6 to U+09EF become "0" to "9"; every other character stays. */
export function toAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    out += cp >= BENGALI_ZERO && cp <= BENGALI_ZERO + 9 ? String(cp - BENGALI_ZERO) : ch;
  }
  return out;
}
