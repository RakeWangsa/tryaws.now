import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { safeNext } from "../request.ts";

/** Where a sign-in ends until the dashboard exists (open point 10). WP4-T7 replaces it. */
export const DEFAULT_LANDING = "/wallet";

/** `path?query` of the panel in the locale; the path was checked by safeNext. */
function localised(locale: Locale, safe: string): string {
  const mark = safe.indexOf("?");
  if (mark === -1) return localePath(locale, safe);
  return `${localePath(locale, safe.slice(0, mark))}${safe.slice(mark)}`;
}

/** `next` through safeNext (U12), localised, or the default landing. */
export function landingPath(locale: Locale, next: unknown): string {
  const safe = safeNext(next);
  return localised(locale, safe ?? DEFAULT_LANDING);
}

/**
 * The address after a sign-in: a customer with an unverified phone goes to /verify first, with
 * `next` kept when it is allowed; everybody else goes to `next` or the default landing. The pending
 * cookie and the ?verified flag never choose a target.
 */
export function landingAfterSignIn(locale: Locale, next: unknown, phoneVerified: boolean): string {
  if (phoneVerified) return landingPath(locale, next);
  const safe = safeNext(next);
  const base = localePath(locale, "/verify");
  return safe === null ? base : `${base}?next=${encodeURIComponent(safe)}`;
}
