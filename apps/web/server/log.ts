// One JSON line per event (R14). Only the keys below are written, and only primitive values: a
// careless caller cannot put a token, a phone number, an address or a URL into a log line.
const ALLOWED_KEYS = new Set([
  "event",
  "severity",
  "paymentId",
  "state",
  "reason",
  "count",
  "ok",
  "expectedMinor",
  "gotMinor",
  "requestId",
]);
const MAX_TEXT = 200;
// WPU-B7 (L6): `reason` and `state` are fixed words (lower-case letters, digits, "_", "." and "-", at
// most 40 characters), never free text. A value of any other shape is dropped.
const FIXED_WORD_KEYS = new Set(["reason", "state"]);
const FIXED_WORD = /^[a-z][a-z0-9_.-]{0,39}$/;

export function writeLog(entry: Readonly<Record<string, unknown>>): void {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (FIXED_WORD_KEYS.has(key) && !FIXED_WORD.test(value)) continue;
      clean[key] = value.slice(0, MAX_TEXT);
    } else if (typeof value === "boolean" || value === null) clean[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
  }
  try {
    console.log(JSON.stringify(clean));
  } catch {
    // a failing sink never changes the result of a request or of a payment
  }
}
