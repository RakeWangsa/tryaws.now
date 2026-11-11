import { describe, expect, it } from "vitest";
import { checkHtml, checkRouteTable, parseRouteTable } from "./app-checks.mjs";

const TABLE = [
  "▲ Next.js 16.4.6 (Turbopack)",
  "",
  "Route (app)",
  "┌ ƒ /_not-found",
  "├ ƒ /[locale]",
  "├ ƒ /[locale]/dev/ui",
  "├ ƒ /[locale]/dev/ui/[shell]",
  "└ ƒ /api/csp-report",
  "",
  "ƒ Proxy (Middleware)",
  "",
  "○  (Static)   prerendered as static content",
  "ƒ  (Dynamic)  server-rendered on demand",
].join("\n");

describe("route table", () => {
  it("parseRouteTable reads the symbols", () => {
    const { routes } = parseRouteTable(
      ["┌ ○ /a", "├ ● /b", "├ ◐ /c", "└ ƒ /d", "ƒ Proxy (Middleware)"].join("\n"),
    );
    expect(routes).toEqual([
      { path: "/a", kind: "static" },
      { path: "/b", kind: "ssg" },
      { path: "/c", kind: "partial" },
      { path: "/d", kind: "dynamic" },
    ]);
  });
  it("checkRouteTable passes when all are ƒ", () => {
    expect(parseRouteTable(TABLE).routes).toHaveLength(5);
    expect(checkRouteTable(TABLE)).toEqual([]);
  });
  it("checkRouteTable names a ○ route such as /_not-found", () => {
    const problems = checkRouteTable(TABLE.replace("┌ ƒ /_not-found", "┌ ○ /_not-found"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/_not-found");
  });
  it("checkRouteTable fails on empty output", () => {
    expect(checkRouteTable("")).toHaveLength(1);
    expect(checkRouteTable("Route (app)\nnothing here")).toHaveLength(1);
  });
});

const NONCE = "abc123NONCE";
const expectWeb = {
  app: "web",
  locale: "bn",
  stylesheets: ["/theme/a.css", "/theme/b.css"],
  bodyAttributes: { "data-theme": "light", "data-color": "green" },
};

function headers(extra = {}) {
  const map = new Map(
    Object.entries({
      "content-security-policy-report-only": `default-src 'self'; script-src 'self' 'nonce-${NONCE}'`,
      "x-content-type-options": "nosniff",
      ...extra,
    }),
  );
  return { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) };
}

function page({
  lang = "bn",
  scripts = `<script nonce="${NONCE}">1</script><script src="/_next/static/x.js" nonce="${NONCE}" async=""></script>`,
  links = `<link rel="stylesheet" href="/theme/a.css"/><link href="/theme/b.css" rel="stylesheet"/><link rel="stylesheet" href="/_next/static/c.css"/>`,
  body = `<body data-theme="light" data-color="green" class="x">`,
  main = `<div class="box-container limit-width"><a href="/en">English</a></div>`,
} = {}) {
  return `<!DOCTYPE html><html lang="${lang}"><head>${links}</head>${body}${main}${scripts}</body></html>`;
}

describe("checkHtml", () => {
  it("a good document has no problem", () => {
    expect(checkHtml(page(), headers(), expectWeb)).toEqual([]);
  });
  it("a script without a nonce fails", () => {
    const html = page({ scripts: `<script>1</script>` });
    expect(checkHtml(html, headers(), expectWeb)).toHaveLength(1);
  });
  it("a script with another page's nonce fails", () => {
    const html = page({ scripts: `<script nonce="OTHER">1</script>` });
    expect(checkHtml(html, headers(), expectWeb)).toHaveLength(1);
  });
  it("a missing report-only header fails", () => {
    const h = headers({ "content-security-policy-report-only": undefined });
    const map = { get: (n) => (n === "content-security-policy-report-only" ? null : h.get(n)) };
    expect(checkHtml(page(), map, expectWeb).length).toBeGreaterThan(0);
  });
  it("a report-only header without a nonce fails", () => {
    const h = headers({ "content-security-policy-report-only": "default-src 'self'" });
    expect(checkHtml(page(), h, expectWeb).length).toBeGreaterThan(0);
  });
  it("an enforced content-security-policy header fails", () => {
    const h = headers({ "content-security-policy": "default-src 'self'" });
    expect(checkHtml(page(), h, expectWeb)).toHaveLength(1);
  });
  it("an inline style attribute fails", () => {
    const html = page({ main: `<div class="box-container limit-width" style="color:red"></div>` });
    expect(checkHtml(html, headers(), expectWeb)).toHaveLength(1);
  });
  it("a wrong html lang fails", () => {
    expect(checkHtml(page({ lang: "en" }), headers(), expectWeb)).toHaveLength(1);
  });
  it("theme stylesheets in another order fail", () => {
    const links = `<link rel="stylesheet" href="/theme/b.css"/><link rel="stylesheet" href="/theme/a.css"/>`;
    expect(checkHtml(page({ links }), headers(), expectWeb)).toHaveLength(1);
  });
  it("a missing theme stylesheet fails", () => {
    const links = `<link rel="stylesheet" href="/theme/a.css"/>`;
    expect(checkHtml(page({ links }), headers(), expectWeb)).toHaveLength(1);
  });
  it("zero or two content containers fail", () => {
    expect(checkHtml(page({ main: "<main></main>" }), headers(), expectWeb)).toHaveLength(1);
    const two = `<div class="box-container limit-width"></div><div class="box-container limit-width"></div>`;
    expect(checkHtml(page({ main: two }), headers(), expectWeb)).toHaveLength(1);
  });
  it("a body without an expected attribute fails", () => {
    const html = page({ body: `<body data-theme="light">` });
    const problems = checkHtml(html, headers(), expectWeb);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("data-color");
  });
  it("an absolute or protocol-relative src, href or action fails", () => {
    for (const bad of [
      `<a href="https://example.com">x</a>`,
      `<img src="http://example.com/a.png">`,
      `<script src="//cdn.example.com/a.js" nonce="${NONCE}"></script>`,
      `<form action="https://example.com/post"></form>`,
    ]) {
      const html = page({ main: `<div class="box-container limit-width">${bad}</div>` });
      expect(checkHtml(html, headers(), expectWeb).length).toBeGreaterThan(0);
    }
  });
  it("a reference to the theme's assets/js fails", () => {
    const html = page({
      main: `<div class="box-container limit-width"><a href="/theme/assets/js/x.js">x</a></div>`,
    });
    expect(checkHtml(html, headers(), expectWeb).length).toBeGreaterThan(0);
  });
  it("a missing x-content-type-options fails", () => {
    const h = headers();
    const map = { get: (n) => (n === "x-content-type-options" ? null : h.get(n)) };
    expect(checkHtml(page(), map, expectWeb)).toHaveLength(1);
  });
});
