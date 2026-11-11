import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { extrasBn } from "./extras-bn.ts";
import { extrasEn } from "./extras-en.ts";

describe("messages of the server tabs, the dashboard and the notifications (WP5-T6)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(extrasBn)).toEqual(messageKeys(extrasEn));
    expect(messageKeys(extrasBn).length).toBeGreaterThan(150);
    for (const tree of [extrasBn, extrasEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed in both locales, with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      for (const space of ["Extras", "Dashboard", "Notifications"]) {
        expect(webMessages[locale][space], `${locale} ${space}`).toBeDefined();
      }
    }
    expect((webMessages.bn["Dashboard"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("shows no account id or ARN, and names AWS only as Amazon Lightsail (U6, 16.13)", () => {
    for (const tree of [extrasBn, extrasEn]) {
      const text = JSON.stringify(tree);
      expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
    }
  });
});
