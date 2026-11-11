import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { publicBn } from "./public-bn.ts";
import { publicEn } from "./public-en.ts";

describe("public site messages (WPP-T1 to WPP-T4)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(publicBn)).toEqual(messageKeys(publicEn));
    expect(messageKeys(publicBn).length).toBeGreaterThan(150);
    for (const tree of [publicBn, publicEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has at least ten questions, and the four required answers of 16.8", () => {
    const items = publicBn.Public.help.items;
    expect(Object.keys(items).length).toBeGreaterThanOrEqual(10);
    expect(publicEn.Public.help.items.realAws.a).toMatch(/^Yes, 100%/);
    expect(publicEn.Public.help.items.noAccount.a).toMatch(/^No\./);
    expect(publicEn.Public.help.items.billing.a).toMatch(/^TiCON Cloud/);
    expect(publicEn.Public.help.items.dataLocation.a).toMatch(/AWS Singapore/);
  });

  it("is composed in both locales with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["Public"], locale).toBeDefined();
    }
    expect((webMessages.bn["Public"] as Messages)["crumb"]).toBeDefined();
    expect(publicBn.Public.home.heroTitle).toMatch(/[ঀ-৿]/);
  });

  it("marks every legal document as a placeholder", () => {
    for (const tree of [publicBn, publicEn]) {
      const docs = tree.Public.legal.docs as Record<string, { sections: Record<string, string> }>;
      expect(Object.keys(docs).sort()).toEqual(["acceptable-use", "privacy", "refund", "terms"]);
      for (const doc of Object.values(docs)) {
        for (const text of Object.values(doc.sections)) expect(text).toMatch(/\[.+\]/);
      }
    }
  });
});
