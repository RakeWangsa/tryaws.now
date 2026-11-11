import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { kycBn } from "./kyc-bn.ts";
import { kycEn } from "./kyc-en.ts";

describe("kyc screen messages (WP2-T4)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(kycBn)).toEqual(messageKeys(kycEn));
    for (const tree of [kycBn, kycEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has a text for every error key the actions can answer with", () => {
    const errors = Object.keys(kycBn.Kyc.error as Record<string, string>).sort();
    expect(errors).toEqual(
      [
        "unauthenticated",
        "forbidden",
        "kyc_verified",
        "kyc_pending",
        "validation",
        "rate_limited",
        "upload_missing",
        "conflict",
        "unavailable",
      ].sort(),
    );
  });

  it("is composed in both locales with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) expect(webMessages[locale]["Kyc"]).toBeDefined();
    expect((webMessages.bn["Kyc"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });
});
