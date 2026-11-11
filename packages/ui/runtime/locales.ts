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

export function localePath(locale: Locale, path: string): string {
  assertSafePath(path);
  if (locale === "bn") return path;
  return path === "/" ? "/en" : `/en${path}`;
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
