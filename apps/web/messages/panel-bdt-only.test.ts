import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { serversBn } from "./servers-bn.ts";
import { serversEn } from "./servers-en.ts";
import { flatLeaves } from "./wording-check.ts";

// WPU-Z2 (owner decision of 2026-11-13): the signed-in panel shows BDT only, so no message of the app names
// a price in US dollars. Out of the scan: the public pages (namespace Public), which show the USD price by
// the same decision, and the dev-only component gallery (Gallery). The checkout keeps the rate line
// "1 USD = ৳{rate}" ("today's dollar rate", the owner's transparency rule): it names the currency, not a price.
const NOT_PANEL = ["Public.", "Gallery."];
const DOLLARS = /dollar|ডলার/i;
// The note under the rate (WPU-Y4 wording, approved by the owner on 2026-11-13) says how the taka amount is
// made from the dollar price. It prints no amount and is not a price label; changing it needs the owner.
const APPROVED_RATE_NOTE = "Orders.review.fx.note";

describe("the panel shows BDT only (WPU-Z2)", () => {
  for (const locale of ["bn", "en"] as const) {
    it(`${locale}: no message outside the public pages names a price in US dollars`, () => {
      const leaves = flatLeaves(webMessages[locale]);
      expect(leaves.size).toBeGreaterThan(1500);
      expect(leaves.has(APPROVED_RATE_NOTE)).toBe(true);
      const found = [...leaves]
        .filter(([key]) => key !== APPROVED_RATE_NOTE && !NOT_PANEL.some((p) => key.startsWith(p)))
        .filter(([, text]) => DOLLARS.test(text))
        .map(([key, text]) => `${key}: ${text}`);
      expect(found).toEqual([]);
    });
  }

  it("the review has no line of the price in US dollars and keeps today's rate", () => {
    for (const tree of [serversBn, serversEn]) {
      const fx: Record<string, string> = tree.Orders.review.fx;
      expect(Object.keys(fx)).not.toContain("usd");
      expect(fx["rateValue"]).toContain("USD = ৳{rate}");
    }
  });

  it("the auto-renew line of the review is the owner's sentence, in Bengali in bn, and names no AWS term", () => {
    expect(serversEn.Orders.review.autoRenew).toBe(
      "Auto-renew is on: the next period is paid from your wallet when this one ends. You can turn it off at any time on the Billing tab.",
    );
    expect(serversBn.Orders.review.autoRenew).toMatch(/^স্বয়ংক্রিয় নবায়ন চালু আছে/);
    for (const tree of [serversBn, serversEn]) {
      expect(tree.Orders.review.autoRenew).not.toMatch(/AWS|Amazon|Lightsail|Route\s?53/i);
    }
  });
});
