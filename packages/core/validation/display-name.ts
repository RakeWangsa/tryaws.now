// ZWNJ (U+200C) and ZWJ (U+200D) are part of correct Bengali spelling (for example "র‍্যাব"), so they
// are allowed between two non-space characters; every other control or format character
// (zero-width space, bidi overrides, BOM) stays refused.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const JOINERS = /[‌‍]/gu;
const BAD_JOINER = /(^|\s)[‌‍]|[‌‍](\s|$)|[‌‍]{2}/u;
const FORBIDDEN = /[<>&"]/;

/**
 * NFC, trimmed, whitespace runs collapsed to one space, 2 to 80 code points. No control or format
 * character (so no zero-width or bidi override) and none of < > & ". Never throws.
 */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 1024) return null;
  const nfc = input.normalize("NFC");
  if (BAD_JOINER.test(nfc)) return null;
  if (CONTROL_OR_FORMAT.test(nfc.replace(JOINERS, "")) || FORBIDDEN.test(nfc)) return null;
  const s = nfc.replace(/\s+/gu, " ").trim();
  const length = Array.from(s).length;
  return length >= 2 && length <= 80 ? s : null;
}
