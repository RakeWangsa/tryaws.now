import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_ABSENT, vendoredThemePresent } from "../theme/present.ts";

// Not `new URL("../", import.meta.url)`: in a jsdom test Vite rewrites that form to an http URL.
const uiRoot = `${dirname(dirname(fileURLToPath(import.meta.url)))}/`;

/** The stylesheets whose classes a kit component may use (all under packages/ui). */
const STYLESHEETS = [
  "theme/assets/css/theme.min.css",
  "theme/assets/css/bootstrap.min.css",
  "theme/assets/css/vendors.min.css",
  "theme/assets/fonts/fontawesome/css/all.min.css",
  "theme/assets/fonts/fonts.min.css",
  "styles/tc.css",
];

/** Classes the mockup uses as script or test hooks that no stylesheet defines. */
export const MOCKUP_HOOKS: readonly string[] = [
  "radios-filter",
  "select-filter",
  "price-container",
  "btn-group-toggle",
  "btn-select-customer",
];

/**
 * Every class selector token of a stylesheet text. Comments, `url(...)` and quoted strings are
 * removed first, so a file name or a content string is not read as a class.
 */
export function classSelectorTokens(css: string): string[] {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/url\([^)]*\)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
  return [...clean.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] as string);
}

let memo: ReadonlySet<string> | undefined;

/** Every class that the theme, Bootstrap, the vendor CSS, Font Awesome, the icon fonts or tc.css defines. */
export function knownClasses(): ReadonlySet<string> {
  if (memo) return memo;
  // Fail closed (R16): without the vendored theme there is no inventory, and an empty one would let
  // every class through. A test that needs it is gated with vendoredThemePresent() (docs/theme.md).
  if (!vendoredThemePresent()) throw new Error(`knownClasses: ${THEME_ABSENT}`);
  const known = new Set<string>(MOCKUP_HOOKS);
  for (const path of STYLESHEETS) {
    for (const token of classSelectorTokens(readFileSync(`${uiRoot}${path}`, "utf8"))) {
      known.add(token);
    }
  }
  memo = known;
  return known;
}
