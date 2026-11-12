import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { diskRestoreBn } from "./disk-restore-bn.ts";
import { diskRestoreEn } from "./disk-restore-en.ts";

describe("messages of the disk restore form (WPU-X2)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(diskRestoreBn)).toEqual(messageKeys(diskRestoreEn));
    for (const tree of [diskRestoreBn, diskRestoreEn]) {
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
      expect(webMessages[locale]["DiskRestore"], locale).toBeDefined();
    }
    expect((webMessages.bn["DiskRestore"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });
});
