import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { serversBn } from "./servers-bn.ts";
import { serversEn } from "./servers-en.ts";
import { flatLeaves } from "./wording-check.ts";

// WPU-X16 (owner decision of 2026-11-15, replacing WPU-Z2 and WPU-Y4): "no one should see the dollar price,
// only BDT will be everywhere for customers". No customer message of the app (public pages, panel, shell,
// kit) names a dollar, the exchange rate or the currency code USD, in Bengali or in English. Out of the scan:
// the dev-only component gallery (Gallery) and two legal sentences (LEGAL_PENDING), whose wording the owner approves separately (docs/legal-drafts/2026-11-15-bdt-only.md). Admin is staff-only
// and has its own messages.
const NOT_CUSTOMER = ["Gallery."];
// The legal sentences that still name the dollar or the exchange rate until the owner approves the new wording. Exactly these
// keys; any other legal key that names a dollar fails the guard. Remove them when legal-*.ts is changed.
const LEGAL_PENDING = [
  "Public.legal.docs.terms.sections.prices.p1",
  "Public.legal.docs.terms.sections.invoices.p1",
  "Public.legal.docs.terms.sections.prices.p2",
  "Public.legal.docs.terms.sections.renewal.p2",
];
const DOLLARS = /USD|US dollar|dollar|ডলার|exchange rate|বিনিময়/i;

function web(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("customers see taka only (WPU-X16)", () => {
  for (const locale of ["bn", "en"] as const) {
    it(`${locale}: no customer message names a dollar, USD or an exchange rate`, () => {
      const leaves = flatLeaves(webMessages[locale]);
      expect(leaves.size).toBeGreaterThan(1500);
      const found = [...leaves]
        .filter(([key]) => !NOT_CUSTOMER.some((p) => key.startsWith(p)))
        .filter(([key]) => !LEGAL_PENDING.includes(key))
        .filter(([, text]) => DOLLARS.test(text))
        .map(([key, text]) => `${key}: ${text}`);
      expect(found).toEqual([]);
    });
  }

  it("the review has no exchange-rate block and no line of the price in US dollars", () => {
    for (const tree of [serversBn, serversEn]) {
      const review: Record<string, unknown> = tree.Orders.review;
      expect(Object.keys(review)).not.toContain("fx");
    }
  });

  it("the generated GEO files (facts.json, llms.txt, llms-full.txt) name no dollar", () => {
    for (const file of ["public/facts.json", "public/llms.txt", "public/llms-full.txt"]) {
      expect(web(file), file).not.toMatch(DOLLARS);
    }
  });

  it("the auto-renew line of the review is the owner's sentence, in Bengali in bn, and names no AWS term", () => {
    expect(serversEn.Orders.review.autoRenew).toBe(
      "Auto-renew is on: the next period is paid from your wallet when this one ends. You can turn it off at any time on the page of this service in the panel.",
    );
    expect(serversBn.Orders.review.autoRenew).toMatch(/^স্বয়ংক্রিয় নবায়ন চালু আছে/);
    for (const tree of [serversBn, serversEn]) {
      expect(tree.Orders.review.autoRenew).not.toMatch(/AWS|Amazon|Lightsail|Route\s?53/i);
    }
  });
});
