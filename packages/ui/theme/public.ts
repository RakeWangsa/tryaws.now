// What the root layouts of both apps need from the theme (WPU-T1, open point 15).
// Browser-safe: it imports nothing, uses no Node global and holds no text for people.

export type ThemeApp = "web" | "admin";
export type ThemeLocale = "bn" | "en";

export const THEME_URL = "/theme";

// The order of the <head> of the mockup (16.3), then tc.css, which is always last.
// aos.min.css (never shipped) and the RTL sheets (open point 20) are left out.
export const THEME_STYLESHEETS = [
  "/theme/assets/fonts/fontawesome/css/all.min.css",
  "/theme/assets/fonts/fonts.min.css",
  "/theme/assets/css/bootstrap.min.css",
  "/theme/assets/css/vendors.min.css",
  "/theme/assets/css/theme.min.css",
  "/theme/tc.css",
] as const;

// The attributes of <body> (16.4). The admin app uses blue on light.
export function themeAttributes(app: ThemeApp): Readonly<Record<`data-${string}`, string>> {
  return {
    "data-layout": "wide",
    "data-color": app === "admin" ? "blue" : "pink",
    "data-background": app === "admin" ? "light" : "dark",
    "data-font": "opensans",
    "data-header": "static",
    "data-radius": "defaultradius",
    "data-textdirection": "ltr",
  };
}

export interface FontPreload {
  href: string;
  as: "font";
  type: "font/woff2";
  crossOrigin: "anonymous";
}

const LATIN_FONT = "/theme/fonts/open-sans-latin-wght-normal.woff2";
const BENGALI_FONT = "/theme/fonts/noto-sans-bengali-bengali-wght-normal.woff2";

// A preload of a font needs crossorigin, even from the same origin, or the browser fetches it twice.
function preload(href: string): FontPreload {
  return { href, as: "font", type: "font/woff2", crossOrigin: "anonymous" };
}

// The Latin file always, the Bengali file for a Bengali page only.
export function fontPreloads(locale: ThemeLocale): FontPreload[] {
  return locale === "bn" ? [preload(LATIN_FONT), preload(BENGALI_FONT)] : [preload(LATIN_FONT)];
}

// The classes of the one div that the root layout puts around all content (16.4): the theme's
// color, card and button rules apply only inside it. WPU-T4 renders the div.
export const THEME_CONTENT_CLASSES = "box-container limit-width";
