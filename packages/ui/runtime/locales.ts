// Locale paths of the two apps (16.7): `bn` at the root, `en` under `/en` (`localePrefix: 'as-needed'`).
// Pure functions: no React, no Next, no Node-only API.

export const LOCALES = ["bn", "en"] as const;
export type Locale = "bn" | "en";
export const DEFAULT_LOCALE: Locale = "bn";

export function isLocale(value: unknown): value is Locale {
  return value === "bn" || value === "en";
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// A path is a same-origin absolute path without query, fragment or control character. Anything else
// could become an open redirect or a header injection, so it is refused (R16).
function assertSafePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    hasControlCharacter(path)
  ) {
    throw new RangeError("path must be an absolute same-origin path without query or fragment");
  }
}

// WPU-X19 (owner decision 2026-11-15): only the home page is bilingual. Every other page is English,
// so a Bengali link to any path but "/" is the English path. To bring Bengali back on the other
// pages, return `path` for `bn` here and drop the redirect of apps/web/proxy.ts (see JOURNEY.md).
export function localePath(locale: Locale, path: string): string {
  assertSafePath(path);
  if (locale === "bn" && path === "/") return "/";
  return path === "/" ? "/en" : `/en${path}`;
}

/**
 * WPU-X19: where a request for `pathname` must go so that no page but the home page is served in
 * bn, or null when it is served as it is. The home page (`/`, and `/bn`, which next-intl sends to
 * `/`) and every `/en...` path stay. Any other path, unprefixed or under `/bn`, goes to the same
 * path under `/en`. Only the request's own same-origin path is used; the caller keeps the query by
 * changing only the pathname of the request URL (U12).
 */
export function englishOnlyTarget(pathname: string): string | null {
  if (pathname === "/en" || pathname.startsWith("/en/")) return null;
  const bare = pathname === "/bn" || pathname.startsWith("/bn/") ? pathname.slice(3) : pathname;
  if (bare === "" || bare === "/") return null;
  return `/en${bare}`;
}

/**
 * WPU-X22: the admin console is English only, home page included. Any path that is not `/en` or
 * under `/en/` goes to the same path under `/en` (`/` to `/en`, `/bn/x` and `/x` to `/en/x`), or
 * null when it is served as it is. Same U12 rule as `englishOnlyTarget`: only the request's own
 * path is used and the caller keeps the query. To bring Bengali back to the console, drop the
 * redirect in apps/admin/proxy.ts (see JOURNEY.md, WPU-X22).
 */
export function adminEnglishTarget(pathname: string): string | null {
  if (pathname === "/en" || pathname.startsWith("/en/")) return null;
  const bare = pathname === "/bn" || pathname.startsWith("/bn/") ? pathname.slice(3) : pathname;
  return bare === "" || bare === "/" ? "/en" : `/en${bare}`;
}

export function localeHrefs(path: string): Record<Locale, string> {
  return { bn: localePath("bn", path), en: localePath("en", path) };
}

// With `as-needed` only `en` is a prefix: `/bn/x` is an ordinary path of the default locale.
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  if (pathname === "/en") return { locale: "en", path: "/" };
  if (pathname.startsWith("/en/")) return { locale: "en", path: pathname.slice(3) };
  return { locale: "bn", path: pathname };
}
