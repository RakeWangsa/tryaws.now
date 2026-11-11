const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const FORBIDDEN = /[<>&"]/;

/**
 * NFC, trimmed, whitespace runs collapsed to one space, 2 to 80 code points. No control or format
 * character (so no zero-width or bidi override) and none of < > & ". Never throws.
 */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 1024) return null;
  const nfc = input.normalize("NFC");
  if (CONTROL_OR_FORMAT.test(nfc) || FORBIDDEN.test(nfc)) return null;
  const s = nfc.replace(/\s+/gu, " ").trim();
  const length = Array.from(s).length;
  return length >= 2 && length <= 80 ? s : null;
}
