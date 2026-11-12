import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { dbg9Bn } from "./dbg9-bn.ts";
import { dbg9En } from "./dbg9-en.ts";

describe("database snapshot and bucket access messages (WPU-G9)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(dbg9Bn)).toEqual(messageKeys(dbg9En));
    for (const tree of [dbg9Bn, dbg9En]) {
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
      expect(webMessages[locale]["DbSnapshots"], locale).toBeDefined();
      expect(webMessages[locale]["BucketAccess"], locale).toBeDefined();
    }
    expect(JSON.stringify(dbg9Bn.DbSnapshots)).toMatch(/[ঀ-৿]/);
  });
  it("shows no account id or ARN (U6)", () => {
    for (const tree of [dbg9Bn, dbg9En]) {
      expect(JSON.stringify(tree)).not.toMatch(/arn:aws|\b\d{12}\b/);
    }
  });
  it("every error key of the cores has a text, and every result key too (U6)", () => {
    for (const key of [
      "unauthenticated",
      "fresh_sign_in_required",
      "flag_off",
      "validation",
      "rate_limited",
      "not_found",
      "name_mismatch",
      "not_allowed",
      "price_unavailable",
      "unavailable",
    ]) {
      expect(dbg9En.DbSnapshots.error).toHaveProperty(key);
    }
    for (const key of ["snapshotCreated", "snapshotDeleting"]) {
      expect(dbg9En.DbSnapshots.done).toHaveProperty(key);
    }
  });
});
