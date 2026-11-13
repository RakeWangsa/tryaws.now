import { R13_APPROVAL_UNTIL, UNPAID_DELETE_AFTER_DAYS, UNPAID_SUSPEND_AFTER_DAYS } from "@tc/core";
import { forbiddenWording, messageKeys } from "@tc/ui";
import { describe, expect, it } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { unpaidRuleEn } from "./messages/unpaidrule.en.ts";
import { unpaidRuleBn } from "./messages/unpaidrule.ts";

// WPU-Z4: the texts of /operations/unpaid-rule in bn and en.
const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
const bengali = (n: number): string =>
  String(n).replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] as string);

describe("AdminUnpaidRule messages", () => {
  it("bn and en have the same keys and no empty text; bn is not a copy of en", () => {
    expect(messageKeys(unpaidRuleBn)).toEqual(messageKeys(unpaidRuleEn));
    for (const tree of [unpaidRuleBn, unpaidRuleEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
    expect(unpaidRuleBn.AdminUnpaidRule.title).not.toBe(unpaidRuleEn.AdminUnpaidRule.title);
  });

  it("holds every result code of the Server Action", () => {
    expect(Object.keys(unpaidRuleEn.AdminUnpaidRule.result).sort()).toEqual([
      "conflict",
      "denied",
      "invalid",
      "not_found",
      "ok",
      "rate_limited",
      "replayed",
      "unavailable",
    ]);
  });

  it("the description names the days and the date of the job (packages/core/lifecycle/unpaid.ts)", () => {
    // 2026-12-01 in Dhaka is the end of the admin approval of R13 (2026-12-02 00:00 +06:00).
    expect(R13_APPROVAL_UNTIL.toISOString()).toBe("2026-12-01T18:00:00.000Z");
    const en = unpaidRuleEn.AdminUnpaidRule.about;
    expect(en.suspend).toContain(`${UNPAID_SUSPEND_AFTER_DAYS} day`);
    expect(en.delete).toContain(`day ${UNPAID_DELETE_AFTER_DAYS}`);
    expect(en.approval).toContain("2026-12-01");
    const bn = unpaidRuleBn.AdminUnpaidRule.about;
    expect(bn.suspend).toContain(`${bengali(UNPAID_SUSPEND_AFTER_DAYS)} দিন`);
    expect(bn.delete).toContain(`${bengali(UNPAID_DELETE_AFTER_DAYS)} দিন`);
    expect(bn.approval).toContain("২০২৬-১২-০১");
    // The confirm box names the same days.
    expect(unpaidRuleEn.AdminUnpaidRule.turnOn.confirm).toContain(
      `${UNPAID_SUSPEND_AFTER_DAYS} day or more`,
    );
    expect(unpaidRuleEn.AdminUnpaidRule.turnOn.confirm).toContain(
      `${UNPAID_DELETE_AFTER_DAYS} days or more`,
    );
    expect(unpaidRuleBn.AdminUnpaidRule.turnOn.confirm).toContain(
      `${bengali(UNPAID_SUSPEND_AFTER_DAYS)} দিন বা তার বেশি`,
    );
    expect(unpaidRuleBn.AdminUnpaidRule.turnOn.confirm).toContain(
      `${bengali(UNPAID_DELETE_AFTER_DAYS)} দিন বা তার বেশি`,
    );
  });

  it("is composed into the app messages for bn and en", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(adminMessages[locale]["AdminUnpaidRule"]).toBeDefined();
    }
  });

  it("holds no forbidden wording", () => {
    expect(forbiddenWording(unpaidRuleBn)).toEqual([]);
    expect(forbiddenWording(unpaidRuleEn)).toEqual([]);
  });
});
