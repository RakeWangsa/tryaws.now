const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,}$/;

/**
 * The lower-case address, or null. Only spaces and tabs are trimmed, so a trailing line break is
 * refused. No IDN: the customer types the punycode form. Never throws.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 1024) return null;
  const s = input
    .replace(/^[ \t]+|[ \t]+$/g, "")
    .normalize("NFKC")
    .toLowerCase();
  if (s.length < 3 || s.length > 254) return null;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local)) return null;
  if (domain.length < 2 || domain.length > 127) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) if (!LABEL.test(label)) return null;
  if (!TLD.test(labels[labels.length - 1] as string)) return null;
  return s;
}
