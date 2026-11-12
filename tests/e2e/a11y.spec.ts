import { appendFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// WPU-X6: for every signed-out page, at 360 px and 1280 px, in bn and en:
//   1. the page answers (final status below 400) and its <html lang> is the locale of the project;
//   2. nothing is requested from outside the machine (self-hosted assets only; the check also keeps
//      the run deterministic: an outside request is aborted and fails the test);
//   3. the page does not scroll sideways;
//   4. axe-core finds no violation of WCAG 2.0/2.1/2.2 level A and AA.
// A11Y_APP picks the app (web or admin); the origin comes from the config. When A11Y_OUT names a file,
// each page appends one JSON line (project, path, violation ids, node counts), for the report.
// Pages that need a session are out of scope here: they redirect a signed-out visitor to /login, which
// is on the list.

const APP = process.env["A11Y_APP"] === "admin" ? "admin" : "web";

const PAGES: Record<"web" | "admin", readonly string[]> = {
  web: [
    "/",
    "/pricing",
    "/products/cloud-servers",
    "/help",
    "/support",
    "/legal/terms",
    "/legal/privacy",
    "/legal/acceptable-use",
    "/legal/refund",
    "/login",
    "/signup",
    "/verify",
    "/forgot-password",
    "/reset-password",
  ],
  admin: ["/login"],
};

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const path of PAGES[APP]) {
  test(`${APP} ${path}`, async ({ page, baseURL }, info) => {
    const bn = info.project.name.startsWith("bn");
    const url = bn ? path : `/en${path === "/" ? "" : path}`;
    const own = new globalThis.URL(baseURL as string).origin;

    const outside: string[] = [];
    await page.route("**/*", async (route) => {
      const target = route.request().url();
      if (!/^https?:/.test(target) || new globalThis.URL(target).origin === own) {
        await route.continue();
        return;
      }
      outside.push(new globalThis.URL(target).origin);
      await route.abort();
    });

    const response = await page.goto(url, { waitUntil: "load" });
    expect(response, "no response").not.toBeNull();
    expect(response?.status() ?? 0, "final status").toBeLessThan(400);
    expect(await page.locator("html").getAttribute("lang")).toBe(bn ? "bn" : "en");
    expect(outside, "requests to another origin").toEqual([]);

    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits, "the page scrolls sideways").toBe(true);

    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const found = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? "unknown",
      nodes: v.nodes.length,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
    const out = process.env["A11Y_OUT"];
    if (out !== undefined && out !== "") {
      appendFileSync(
        out,
        `${JSON.stringify({ app: APP, project: info.project.name, path: url, found })}\n`,
      );
    }
    expect(found, "axe violations").toEqual([]);
  });
}
