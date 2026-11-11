import { CLOCK_SKEW_SECONDS, FRESH_SIGN_IN_MINUTES } from "./config";
import type { Clock, CustomerSession, Result } from "./types";

// 6.1 and F: a destructive or sensitive action needs a sign-in within the last 10 minutes. The check
// is about time only; it never reads the customer id. Fail closed (R16): a time that is not a valid
// Date, or lies further in the future than the allowed skew, proves nothing and is refused.
export function requireFreshSignIn(s: CustomerSession, clock: Clock): Result<true> {
  const signedIn = s.signedInAt instanceof Date ? s.signedInAt.getTime() : Number.NaN;
  const age = clock.now().getTime() - signedIn; // NaN when either side is not a time
  const fresh = age >= -CLOCK_SKEW_SECONDS * 1000 && age <= FRESH_SIGN_IN_MINUTES * 60_000;
  if (!fresh)
    return { ok: false, error: "unauthenticated", data: { reason: "fresh_sign_in_required" } };
  return { ok: true, value: true };
}
