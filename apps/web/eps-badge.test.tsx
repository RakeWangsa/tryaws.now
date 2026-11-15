import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { publicBn } from "./messages/public-bn.ts";
import { publicEn } from "./messages/public-en.ts";
import { renderers } from "./app/[locale]/(public)/public-states.tsx";
import type { Renderer } from "./app/[locale]/(public)/public-states.tsx";
import { UNAVAILABLE, openCatalog } from "./app/[locale]/(public)/public.fixtures.ts";

// WPU-X21: the official "Pay with EPS" badge in the public footer and on the home page.
vi.mock("./app/[locale]/(public)/products/[family]/actions.ts", () => ({
  notifyMeAction: async () => ({ status: "idle" }),
}));

const BRAND = new URL("./public/brand/", import.meta.url);

/** Width and height of a PNG, read from its IHDR chunk. */
function pngSize(name: string): { width: number; height: number } {
  const file = readFileSync(new URL(name, BRAND));
  expect(file.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

let all: Record<string, Renderer>;
beforeAll(async () => {
  all = renderers(await openCatalog(), UNAVAILABLE);
});

describe("the badge files", () => {
  it("exist with the dimensions the component declares", () => {
    expect(pngSize("eps-pay-dark.png")).toEqual({ width: 1120, height: 196 });
    expect(existsSync(new URL("eps-pay-light.png", BRAND))).toBe(true);
    expect(pngSize("eps-pay-light.png").width).toBe(1120);
  });

  it("no file of public/brand is over 200 KB", () => {
    for (const name of readdirSync(BRAND)) {
      expect(statSync(new URL(name, BRAND)).size, name).toBeLessThanOrEqual(200 * 1024);
    }
  });
});

describe("the badge in the public footer and on the home page", () => {
  it("every public page shows it in the footer with the alt text of its language", () => {
    const alt: Record<Locale, string> = {
      bn: publicBn.Public.epsBadge.alt,
      en: publicEn.Public.epsBadge.alt,
    };
    expect(alt.en).toBe(
      "Pay with EPS: Visa, Mastercard, American Express, DBBL Nexus, UnionPay and Bangladeshi mobile wallets and banks. Verified by EPS.",
    );
    for (const [id, render] of Object.entries(all)) {
      for (const locale of ["bn", "en"] as const) {
        const page = render(locale);
        const footer = /<footer[^]*<\/footer>/.exec(page)?.[0] ?? "";
        expect(footer, `${id} ${locale}`).toContain(escape(alt[locale]));
        expect(footer, `${id} ${locale}`).toContain('src="/brand/eps-pay-dark.png"');
      }
    }
  });

  it("the home page shows it in its body too, with size, lazy loading and no style", () => {
    for (const locale of ["bn", "en"] as const) {
      const page = all["home.data"]!(locale);
      const main = /<main[\s>][^]*<\/main>/.exec(page)?.[0] ?? "";
      expect(count(main, /eps-pay-dark\.png/g), locale).toBe(1);
      const img = /<img[^>]*eps-pay-dark\.png[^>]*>/.exec(main)?.[0] ?? "";
      expect(img).toContain('width="1120"');
      expect(img).toContain('height="196"');
      expect(img).toContain('loading="lazy"');
      expect(img).not.toContain("style=");
    }
  });
});
