import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adminMessages } from "../../admin/i18n/messages.ts";
import { webMessages } from "../i18n/messages.ts";
import { LATIN_ONLY_BN, SAME_IN_BOTH } from "./wording-allow.ts";
import { checkWording, flatLeaves, isLanguageNeutral, placeholdersOf } from "./wording-check.ts";

// WP9-T5: every namespace of web (kit, Shell, Aws, app, Public...) and admin, in both locales.
const LEGAL = ["Public.legal."];
const trademark =
  "Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates.";
const show = (f: readonly { key: string; rule: string; text: string }[]): string[] =>
  f.map((x) => `${x.rule}  ${x.key}  ${x.text.slice(0, 90)}`);

describe("wording check (WP9-T5)", () => {
  it("web messages: parity, no empty, no copied English, placeholders, no forbidden wording", () => {
    const findings = checkWording(webMessages.bn, webMessages.en, {
      sameInBoth: SAME_IN_BOTH,
      latinOnlyBn: LATIN_ONLY_BN,
      legalPrefixes: LEGAL,
    });
    expect(show(findings)).toEqual([]);
    expect(flatLeaves(webMessages.bn).size).toBeGreaterThan(1500);
  });

  it("admin messages: the same rules", () => {
    const findings = checkWording(adminMessages.bn, adminMessages.en, {
      sameInBoth: SAME_IN_BOTH,
      latinOnlyBn: LATIN_ONLY_BN,
    });
    expect(show(findings)).toEqual([]);
  });

  it("the trademark line of 16.13 is in the spec and in the shell of both locales", () => {
    const spec = readFileSync(
      fileURLToPath(
        new URL("../../../docs/spec/16/16.13-states-wording-and-formats.md", import.meta.url),
      ),
      "utf8",
    );
    expect(spec).toContain(trademark);
    for (const locale of ["bn", "en"] as const) {
      expect(flatLeaves(webMessages[locale]).get("Aws.trademark"), locale).toBe(trademark);
    }
  });

  it("the checker itself catches what it promises", () => {
    const bad = {
      A: {
        arn: "arn:aws:iam::1",
        id: "acct 123456789012",
        err: "AccessDenied",
        name: "tc-inst-ab12",
        ls: "AWS Lightsail",
        same: "Save now",
        empty: "",
        ph: "Hi {name}",
        todo: "TODO",
        joined: "MyAWS",
      },
    };
    const good = { A: { ...bad.A, ph: "Hi {user}" } };
    const rules = new Set(checkWording(bad, good).map((f) => f.rule.replace(/\(.*/, "")));
    for (const rule of [
      "arn",
      "account-id",
      "aws-error-code",
      "internal-name",
      "aws-lightsail",
      "aws-in-name",
      "same-in-both",
      "empty-bn",
      "placeholder-mismatch",
      "todo",
      "latin-only-bn",
    ]) {
      expect(rules.has(rule), rule).toBe(true);
    }
    const missing = checkWording({ A: { b: "ঢাকা" } }, { A: { b: "Dhaka", extra: "x" } });
    expect(missing.map((f) => f.rule)).toContain("missing-in-bn");
    expect(isLanguageNeutral("TryAWS.now 24 {n} GB")).toBe(true);
    expect(isLanguageNeutral("Save")).toBe(false);
    expect(placeholdersOf("{count, plural, one {# x} other {{n} y}}")).toEqual(["count", "n"]);
  });

  // WPU-Z8, owner decision 2026-11-13: the brand is "TryAWS.now". That is a deliberate deviation from 16.13
  // ("no AWS mark inside a product name, a company name or a domain name"; the trademark risk is recorded in
  // JOURNEY.md). The exception is narrow: the exact token only. AWS joined to any other word still fails,
  // and every other rule about AWS still applies next to the brand.
  describe("the brand token TryAWS.now (WPU-Z8)", () => {
    const rulesOf = (bn: string, en: string): string[] =>
      checkWording({ A: { k: bn } }, { A: { k: en } }).map((f) => f.rule);

    it("accepts the exact token as the brand, alone, in a sentence and in Bengali text", () => {
      expect(isLanguageNeutral("TryAWS.now")).toBe(true);
      for (const [bn, en] of [
        ["TryAWS.now", "TryAWS.now"],
        ["TryAWS.now অ্যাডমিন", "TryAWS.now Admin"],
        [
          "বিক্রি, বিল ও সাপোর্ট TryAWS.now দেয়।",
          "TryAWS.now sells, bills and supports the service.",
        ],
        ["TryAWS.now-এর নিয়ম", "The rules of TryAWS.now."],
        [
          "এই শর্তাবলিতে “TryAWS.now” বলতে কোম্পানিকে বোঝায়।",
          "In these terms, “TryAWS.now” means the company.",
        ],
        ["TryAWS.now: আপনার পাসওয়ার্ড বদলানো হয়েছে।", "TryAWS.now: your password was changed."],
      ] as const) {
        expect(rulesOf(bn, en), en).toEqual([]);
      }
    });

    it("rejects every other name with AWS inside it, the near misses of the brand included", () => {
      for (const name of [
        "TryAWS",
        "TryAWS.com",
        "tryAWS.now",
        "TRYAWS.NOW",
        "TryAWS.nowhere",
        "TryAWS.now.com",
        "MyTryAWS.now",
        "AWS.now",
        "MyAWS",
        "AWSome",
        "AWS-Hosting",
        "Cloud-AWS",
      ]) {
        const found = rulesOf(`${name} প্যানেল`, `${name} panel`);
        expect(found, name).toContain("aws-in-name(bn)");
        expect(found, name).toContain("aws-in-name(en)");
      }
      // A Bengali case ending after the mark is grammar, not a joined word ("AWS-এর" = "of AWS").
      expect(rulesOf("AWS-এর নিয়ম", "The rules of AWS.")).toEqual([]);
      // Only the exact token is language-neutral: a near miss reads as words a translator would change.
      expect(isLanguageNeutral("TryAWS")).toBe(false);
      expect(isLanguageNeutral("tryaws.now")).toBe(false);
    });

    it("keeps every other AWS rule next to the brand", () => {
      const found = (text: string): string[] => rulesOf(text, text);
      expect(found("TryAWS.now AWS Lightsail")).toEqual(
        expect.arrayContaining(["aws-lightsail(en)", "ticon-aws-product(en)"]),
      );
      expect(found("TryAWS.now Lightsail")).toEqual(
        expect.arrayContaining(["bare-lightsail(en)", "ticon-aws-product(en)"]),
      );
      expect(found("TryAWS.now's AWS servers")).toContain("ticon-aws-product(en)");
      expect(found("TryAWS.now, powered by AWS")).toContain("powered-by-aws(en)");
      expect(found("TryAWS.now, an official AWS partner")).toContain("aws-endorses(en)");
      expect(found("TryAWS.now AWS Cloud Server")).toContain("aws-sku-name(en)");
    });
  });
});
