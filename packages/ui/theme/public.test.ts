import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontFaces } from "./font-faces.ts";
import { TC_FONTS, TC_OWN_FONTS } from "./manifest.ts";
import { mockupPresent } from "./present.ts";
import {
  THEME_CONTENT_CLASSES,
  THEME_STYLESHEETS,
  fontPreloads,
  themeAttributes,
} from "./public.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mockup = `${repoRoot}design/mockup/template`;
// The mockup is the paid Antler theme; without it (a public checkout) the tests that read it skip
// (docs/theme.md) and the rest run.
const withMockup = it.skipIf(!mockupPresent());
const themeCss = mockupPresent() ? readFileSync(`${mockup}/assets/css/theme.min.css`, "utf8") : "";

describe("THEME_STYLESHEETS", () => {
  withMockup("is the order of the <head> of all 53 pages of the mockup, then tc.css", () => {
    const orders = new Set<string>();
    let pages = 0;
    for (const name of readdirSync(mockup).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(`${mockup}/${name}`, "utf8");
      const head = html.slice(0, html.indexOf("</head>"));
      const links = [...head.matchAll(/<link\b[^>]*>/gi)]
        .map((m) => m[0])
        .filter((tag) => /rel=['"]stylesheet['"]/i.test(tag) && !/class=['"][^'"]*rtl/i.test(tag))
        .map((tag) => /href=['"]([^'"]+)['"]/i.exec(tag)?.[1] ?? "")
        // aos.min.css is never shipped (16.3)
        .filter((href) => !href.endsWith("aos.min.css"))
        .map((href) => `/theme/${href}`);
      if (links.length === 0) continue; // header.html, footer.html and the like have no <head>
      pages++;
      orders.add(links.join(" "));
    }
    expect(pages).toBe(53);
    expect([...orders]).toEqual([THEME_STYLESHEETS.slice(0, 5).join(" ")]);
    expect(THEME_STYLESHEETS.at(-1)).toBe("/theme/tc.css");
  });

  it("holds plain paths under /theme, without a query", () => {
    for (const href of THEME_STYLESHEETS) expect(href).toMatch(/^\/theme\/[\w./-]+\.css$/);
  });
});

describe("THEME_CONTENT_CLASSES (16.4)", () => {
  withMockup(
    "is the wrapper that all 53 pages of the mockup have, and the theme's rules need it",
    () => {
      expect(THEME_CONTENT_CLASSES).toBe("box-container limit-width");
      const wrapped = readdirSync(mockup)
        .filter((name) => name.endsWith(".html"))
        .filter((name) =>
          readFileSync(`${mockup}/${name}`, "utf8").includes(
            `<div class="${THEME_CONTENT_CLASSES}"`,
          ),
        );
      expect(wrapped).toHaveLength(53); // measured on 2026-11-11 (Antler 4.5.0)
      expect(themeCss).toContain(".box-container .bg-colorstyle");
    },
  );
});

describe("themeAttributes (16.4)", () => {
  const text = (app: "web" | "admin"): string =>
    Object.entries(themeAttributes(app))
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");

  it("is the line of 16.4 for the customer app and the same with blue and light for the admin app", () => {
    expect(text("web")).toBe(
      'data-layout="wide" data-color="pink" data-background="dark" data-font="opensans" data-header="static" data-radius="defaultradius" data-textdirection="ltr"',
    );
    expect(text("admin")).toBe(
      'data-layout="wide" data-color="blue" data-background="light" data-font="opensans" data-header="static" data-radius="defaultradius" data-textdirection="ltr"',
    );
  });

  withMockup("uses values that the theme has a rule for (wide is the default and has none)", () => {
    for (const app of ["web", "admin"] as const) {
      for (const [name, value] of Object.entries(themeAttributes(app))) {
        if (name === "data-layout") continue;
        expect(themeCss, `${name}=${value}`).toContain(`[${name}=${value}]`);
      }
    }
    expect(themeCss).not.toContain("[data-layout=wide]");
    for (const other of ["boxed", "frame", "wideboxed"])
      expect(themeCss).toContain(`[data-layout=${other}]`);
  });

  it("returns a new object each time", () => {
    expect(themeAttributes("web")).not.toBe(themeAttributes("web"));
  });
});

describe("fontPreloads", () => {
  const tcFaces = readFontFaces(readFileSync(`${repoRoot}packages/ui/styles/tc.css`, "utf8"));

  it("preloads the Latin file always and the Bengali file only for a Bengali page, with crossorigin", () => {
    expect(fontPreloads("bn")).toEqual([
      {
        href: "/theme/fonts/open-sans-latin-wght-normal.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        href: "/theme/fonts/hind-siliguri-400.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
    ]);
    expect(fontPreloads("en").map((p) => basename(p.href))).toEqual([
      "open-sans-latin-wght-normal.woff2",
    ]);
  });

  it("names files that tc.css declares and that the publish stage copies", () => {
    const declared = new Set(tcFaces.map((f) => basename(f.url)));
    const copied = new Set<string>([
      ...TC_FONTS.flatMap((f) => f.files),
      ...TC_OWN_FONTS.flatMap((f) => f.files),
    ]);
    for (const preload of fontPreloads("bn")) {
      expect(declared.has(basename(preload.href)), preload.href).toBe(true);
      expect(copied.has(basename(preload.href)), preload.href).toBe(true);
    }
  });
});

it("public.ts is safe for the browser: it imports nothing and uses no Node global", () => {
  const source = readFileSync(`${repoRoot}packages/ui/theme/public.ts`, "utf8");
  expect(source).not.toMatch(/^\s*import\s|\bimport\(|\brequire\(/m);
  expect(source).not.toMatch(/\bprocess\.|\bBuffer\b/);
});
