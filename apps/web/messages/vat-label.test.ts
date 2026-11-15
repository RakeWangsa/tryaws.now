import { readFileSync, readdirSync, statSync } from "node:fs";
import { INVOICE_AWS_LABEL, INVOICE_STEP_LABELS } from "@tc/core";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { flatLeaves } from "./wording-check.ts";

// WPU-X26 (owner decision of 2026-11-15, in chat: "VAT is VAT, no need to mention Korea or BD"). Wherever
// a customer sees a tax label it reads just VAT (bn: ভ্যাট): never the country. The pricing steps keep their
// codes (korea_vat, bd_vat) in data, and apps/admin keeps showing the real step names (staff only), so
// admin messages are out of this scan. Only labels are subject here: no amount, rate or rule.
const COUNTRY_VAT =
  /Korea|কোরিয়া|Bangladesh VAT|বাংলাদেশের\s*VAT|বাংলাদেশের\s*ভ্যাট|বাংলাদেশ\s*ভ্যাট/i;

describe("the tax label is VAT, no country (WPU-X26)", () => {
  for (const locale of ["bn", "en"] as const) {
    it(`${locale}: no customer message names a country with the VAT`, () => {
      const leaves = flatLeaves(webMessages[locale]);
      expect(leaves.size).toBeGreaterThan(1500);
      const found = [...leaves]
        .filter(([key]) => !key.startsWith("Gallery."))
        .filter(([, text]) => COUNTRY_VAT.test(text))
        .map(([key, text]) => `${key}: ${text}`);
      expect(found).toEqual([]);
    });
  }

  it("the step label of the review and the Billing tab is VAT / ভ্যাট", () => {
    const en = flatLeaves(webMessages.en);
    const bn = flatLeaves(webMessages.bn);
    expect(en.get("Orders.review.step.bd_vat")).toBe("VAT");
    expect(bn.get("Orders.review.step.bd_vat")).toBe("ভ্যাট");
  });

  it("the first line is not called the bare AWS price (it holds the pass-through VAT) but names Amazon Web Services", () => {
    const en = flatLeaves(webMessages.en).get("kit.priceBreakdown.base") ?? "";
    const bn = flatLeaves(webMessages.bn).get("kit.priceBreakdown.base") ?? "";
    for (const text of [en, bn]) {
      expect(text).toContain("Amazon Web Services");
      expect(text).not.toMatch(/AWS service price|AWS সার্ভিস মূল্য/);
    }
  });

  it("the labels stored on a new invoice name no country", () => {
    expect(INVOICE_STEP_LABELS.korea_vat).toEqual({ bn: "ভ্যাট", en: "VAT" });
    expect(INVOICE_STEP_LABELS.bd_vat).toEqual({ bn: "ভ্যাট", en: "VAT" });
    expect(JSON.stringify([...Object.values(INVOICE_STEP_LABELS), INVOICE_AWS_LABEL])).not.toMatch(
      COUNTRY_VAT,
    );
  });

  it("the generated GEO files and the notification templates name no country with the VAT", () => {
    const web = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    for (const file of ["public/facts.json", "public/llms.txt", "public/llms-full.txt"]) {
      expect(web(file), file).not.toMatch(COUNTRY_VAT);
    }
    const notify = new URL("../../../packages/notify/", import.meta.url);
    const walk = (dir: URL): URL[] =>
      readdirSync(dir).flatMap((name) => {
        if (name === "node_modules") return [];
        const child = new URL(name, dir);
        return statSync(child).isDirectory() ? walk(new URL(`${name}/`, dir)) : [child];
      });
    const files = walk(notify).filter((u) => /\.(ts|tsx|html|json|txt)$/.test(u.pathname));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      if (/\.test\./.test(f.pathname)) continue;
      expect(readFileSync(f, "utf8"), f.pathname).not.toMatch(COUNTRY_VAT);
    }
  });
});
