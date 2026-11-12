import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { supportBn } from "./support-bn.ts";
import { supportEn } from "./support-en.ts";

describe("support form messages (WP9-T4b)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(supportBn)).toEqual(messageKeys(supportEn));
    for (const tree of [supportBn, supportEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has a text for every category and every error the action can answer with", () => {
    const form = supportBn.SupportForm.form.category as Record<string, string>;
    expect(Object.keys(form).sort()).toEqual(
      ["legend", "billing", "technical", "kyc", "domain", "abuse", "other"].sort(),
    );
    expect(Object.keys(supportBn.SupportForm.error).sort()).toEqual(
      ["unauthenticated", "validation", "rate_limited", "forbidden", "unavailable"].sort(),
    );
  });

  it("is composed in both locales with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const)
      expect(webMessages[locale]["SupportForm"]).toBeDefined();
    expect((webMessages.bn["SupportForm"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });
});
