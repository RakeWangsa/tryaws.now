import { matchPattern } from "./glob.ts";

export const MOCKUP_ASSETS = "design/mockup/template/assets";
export const VENDORED_ASSETS = "packages/ui/theme/assets";
export const TC_CSS = "packages/ui/styles/tc.css";
export const APPS = ["web", "admin"] as const;
export type AppName = (typeof APPS)[number];

export function appThemeDir(app: AppName): string {
  return `apps/${app}/public/theme`;
}

/** `cell` is the index of the cell in verify/baseline.json (theme.shipped[cell]). */
export interface ShippedRow {
  readonly cell: number;
  readonly pattern: string;
  readonly only?: readonly string[];
  readonly inline?: true;
}

/** `cell` is the index in theme.neverShipped; `null` marks a row this plan added. */
export interface NeverRow {
  readonly cell: number | null;
  readonly token: string;
}

export interface ThemeManifest {
  readonly shipped: readonly ShippedRow[];
  readonly neverShipped: readonly NeverRow[];
  readonly knownMissing: readonly string[];
  readonly unshippedFallbacks: readonly string[];
}

const PATTERN_FILES = [
  "patterns/cpupath-w.svg",
  "patterns/cpupath.svg",
  "patterns/exapath-w.svg",
  "patterns/exapath.svg",
  "patterns/motpath-w.svg",
  "patterns/motpath.svg",
  "patterns/promo-w.svg",
  "patterns/promopath.svg",
] as const;

/** One `fonts/svg/<name>.svg` per line, added by the task whose component imports it. */
export const INLINE_SVGS: readonly string[] = [];

export const THEME_MANIFEST: ThemeManifest = {
  shipped: [
    { cell: 0, pattern: "css/bootstrap.min.css" },
    { cell: 1, pattern: "css/vendors.min.css" },
    { cell: 1, pattern: "img/filter/*.svg" },
    { cell: 2, pattern: "css/theme.min.css" },
    { cell: 3, pattern: "patterns/*.svg", only: PATTERN_FILES },
    { cell: 4, pattern: "fonts/fonts.min.css" },
    { cell: 4, pattern: "fonts/cloudicon/*" },
    { cell: 4, pattern: "fonts/evafeat/*" },
    { cell: 5, pattern: "fonts/fontawesome/css/all.min.css" },
    { cell: 5, pattern: "fonts/fontawesome/webfonts/*.woff2" },
    { cell: 6, pattern: "apps/*.svg" },
    { cell: 7, pattern: "fonts/svg/*.svg", only: INLINE_SVGS, inline: true },
  ],
  neverShipped: [
    { cell: 0, token: "js/*" },
    { cell: 0, token: "php/*" },
    { cell: 0, token: "order-form/" },
    { cell: 1, token: "css/aos.min.css" },
    { cell: 1, token: "css/rtl/*" },
    { cell: 2, token: "img/topbanner*.jpg" },
    { cell: 2, token: "img/partners/*" },
    { cell: 2, token: "img/avatars/*" },
    { cell: 2, token: "img/blog/*" },
    { cell: 2, token: "casestudy/*" },
    { cell: 2, token: "videos/*" },
    { cell: 3, token: "img/logo.svg" },
    { cell: 3, token: "img/logo-light.svg" },
    { cell: 3, token: "img/symbol.svg" },
    { cell: 3, token: "img/favicon.ico" },
    { cell: 4, token: "locales/*" },
    { cell: null, token: "fonts/fontawesome/js/*" },
  ],
  knownMissing: [
    "img/arrow-right-2.png",
    "img/arrow-left-2.png",
    "img/arrow-left-2-act.png",
    "fonts/evafeat/evafeat.svg",
  ],
  unshippedFallbacks: [
    "fonts/fontawesome/webfonts/fa-brands-400.ttf",
    "fonts/fontawesome/webfonts/fa-regular-400.ttf",
    "fonts/fontawesome/webfonts/fa-solid-900.ttf",
    "fonts/fontawesome/webfonts/fa-v4compatibility.ttf",
  ],
};

export const TC_FONTS = [
  {
    id: "open-sans",
    package: "@fontsource-variable/open-sans",
    files: ["open-sans-latin-ext-wght-normal.woff2", "open-sans-latin-wght-normal.woff2"],
  },
  {
    id: "noto-sans-bengali",
    package: "@fontsource-variable/noto-sans-bengali",
    files: ["noto-sans-bengali-bengali-wght-normal.woff2"],
  },
] as const;

/**
 * Font files that the repository itself holds (not an installed package): Hind Siliguri, which Fontsource
 * does not offer as a static family under the name used here. Source, version and licence: JOURNEY.md
 * (WPU-F1). `dir` is relative to the repository root.
 */
export const TC_OWN_FONTS = [
  {
    id: "hind-siliguri",
    dir: "packages/ui/fonts/hind-siliguri",
    files: [
      "hind-siliguri-400.woff2",
      "hind-siliguri-500.woff2",
      "hind-siliguri-600.woff2",
      "hind-siliguri-700.woff2",
    ],
    license: "OFL.txt",
  },
] as const;

export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".map", ".php", ".tpl"] as const;
export const FORBIDDEN_SEGMENTS = ["order-form", "whmcs-template"] as const;

/** A folder token becomes a pattern for every file below it, at any depth. */
export function neverPattern(token: string): string {
  if (token.endsWith("/*")) return token.slice(0, -1) + "**";
  if (token.endsWith("/")) return token + "**";
  return token;
}

/** Why `path` (relative to the assets root) may never be shipped, or `null`. */
export function forbiddenReason(
  path: string,
  manifest: ThemeManifest = THEME_MANIFEST,
): string | null {
  const lower = path.toLowerCase();
  const extension = SCRIPT_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (extension !== undefined) return `a ${extension} file (U2)`;
  const segment = FORBIDDEN_SEGMENTS.find((name) => lower.split("/").includes(name));
  if (segment !== undefined) return `a file under ${segment}/ (U2)`;
  const row = manifest.neverShipped.find((r) => matchPattern(neverPattern(r.token), path));
  return row === undefined ? null : `on the never-shipped list: ${row.token}`;
}
