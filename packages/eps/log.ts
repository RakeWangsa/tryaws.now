import type { EpsDeps } from "./deps";

// R14: the only fields a log line of this package may carry. Any other key is dropped, not thrown,
// so a careless call cannot leak a hash, a URL, an id of EPS or a name.
const ALLOWED = new Set(["paymentId", "state", "reason", "count", "ok"]);
const MAX_TEXT = 100;
// WPU-B7 (L6): `reason` and `state` are fixed words (lower-case letters, digits, "_", "." and "-", at
// most 40 characters), never free text. A value of any other shape is dropped, so a message, an id, a
// URL or a name cannot reach a log line through these two keys.
const FIXED_WORD_KEYS = new Set(["reason", "state"]);
const FIXED_WORD = /^[a-z][a-z0-9_.-]{0,39}$/;

export function safeLog(
  deps: Pick<EpsDeps, "log">,
  event: string,
  fields: Record<string, unknown>,
): void {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === "string") {
      if (FIXED_WORD_KEYS.has(key) && !FIXED_WORD.test(value)) continue;
      clean[key] = value.slice(0, MAX_TEXT);
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      clean[key] = value;
  }
  try {
    deps.log(event, clean);
  } catch {
    // a failing logger never changes the result of a payment
  }
}
