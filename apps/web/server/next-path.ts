// The U12 allow-list for a `next` value (a redirect target taken from a request). No imports: this file
// is used by client components too (the tab links of the sign-in screens).

/** U12: the only route prefixes a `next` value may lead to. */
export const NEXT_PREFIXES: readonly string[] = Object.freeze([
  "/dashboard",
  "/wallet",
  "/orders",
  "/servers",
  "/invoices",
  "/settings",
  "/support",
  // WPU-N1 (audit C.16): the other routes of the customer panel (apps/web/app/[locale]/(panel)). Relative
  // paths only; the admin app has its own routes and none of them is here.
  "/kyc",
  "/dns",
  "/domains",
  "/databases",
  "/storage",
  "/load-balancers",
  "/containers",
  "/cdn",
  "/billing",
  "/snapshots",
  "/static-ips",
  "/notifications",
]);

const MAX_NEXT_LENGTH = 2048;
// A parse base that is never a real host: a value that leaves it was not a relative path.
const PARSE_BASE = "http://next.invalid";

function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * WPU-X20: the sign-in link of "please sign in again" (a fresh sign-in is needed, 6.1). `pathname` is the current
 * path with its locale prefix; the locale is dropped and the rest must pass the U12 allow-list, else `next` is
 * left out. `reauth=1` lets the login page open for a customer who is signed in (see auth-page.ts); it chooses
 * nothing else: the recent-sign-in rule is checked on the new session as before.
 */
export function reauthHref(locale: string, pathname: string): string {
  const stripped = pathname.replace(/^\/(bn|en)(?=\/|$)/, "");
  const next = safeNext(stripped === "" ? "/" : stripped);
  const base = `/${locale}/login?reauth=1`;
  return next === null ? base : `${base}&next=${encodeURIComponent(next)}`;
}

/**
 * A relative path of the panel, normalised, or null. Refused: anything that is not text, is long,
 * holds a control character or a backslash, does not start with one "/", changes host when parsed,
 * or whose normalised path is not under a prefix of the list (so "/wallet/../admin" and "/walletx"
 * fail, and "/%2F%2Fevil.com" is not a prefix). The query is kept.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || hasControlOrBackslash(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  const path = url.pathname;
  const allowed = NEXT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return allowed ? `${path}${url.search}` : null;
}
