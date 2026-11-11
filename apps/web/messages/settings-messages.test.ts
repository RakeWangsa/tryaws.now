import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { settingsBn } from "./settings-bn.ts";
import { settingsEn } from "./settings-en.ts";

describe("settings screen messages (WP2-T5)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(settingsBn)).toEqual(messageKeys(settingsEn));
    for (const tree of [settingsBn, settingsEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has a text for every error key of the cores and every field code they can return", () => {
    const errors = Object.keys(settingsBn.Settings.error).sort();
    expect(errors).toEqual(
      [
        "unauthenticated",
        "forbidden",
        "fresh_sign_in_required",
        "validation",
        "rate_limited",
        "wrong_password",
        "invalid_code",
        "expired_code",
        "unavailable",
      ].sort(),
    );
    // The codes of checkPassword (PasswordIssue) and of the cores.
    for (const code of [
      "required",
      "too_short",
      "too_long",
      "same_as_email",
      "too_common",
      "repeated",
      "same_as_current",
      "mismatch",
      "invalid",
      "wrong",
      "same",
      "malformed",
      "expired",
    ]) {
      expect(Object.keys(settingsBn.Settings.field), code).toContain(code);
    }
  });

  it("is composed in both locales with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["Settings"]).toBeDefined();
    }
    const profile = (webMessages.bn["Settings"] as Messages)["profile"] as Messages;
    expect(profile["heading"] as string).toMatch(/[ঀ-৿]/);
  });
});
