import type { EpsDeps } from "./deps";

// R14: the only fields a log line of this package may carry. Any other key is dropped, not thrown,
// so a careless call cannot leak a hash, a URL, an id of EPS or a name.
const ALLOWED = new Set(["paymentId", "state", "reason", "count", "ok"]);
const MAX_TEXT = 100;

export function safeLog(
  deps: Pick<EpsDeps, "log">,
  event: string,
  fields: Record<string, unknown>,
): void {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, MAX_TEXT);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      clean[key] = value;
  }
  try {
    deps.log(event, clean);
  } catch {
    // a failing logger never changes the result of a payment
  }
}
