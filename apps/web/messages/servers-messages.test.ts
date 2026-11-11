import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { serversBn } from "./servers-bn.ts";
import { serversEn } from "./servers-en.ts";

describe("server screen messages (WP4-T7)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(serversBn)).toEqual(messageKeys(serversEn));
    expect(messageKeys(serversBn).length).toBeGreaterThan(120);
    for (const tree of [serversBn, serversEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed in both locales with bn text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      for (const space of ["Servers", "Orders", "SshKeys", "Flow"]) {
        expect(webMessages[locale][space], `${locale} ${space}`).toBeDefined();
      }
    }
    expect((webMessages.bn["Servers"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("shows no account id or ARN anywhere in the texts (U6)", () => {
    for (const tree of [serversBn, serversEn]) {
      const text = JSON.stringify(tree);
      expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
    }
  });
});
