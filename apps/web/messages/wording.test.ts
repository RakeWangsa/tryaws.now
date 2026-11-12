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
    expect(isLanguageNeutral("MeghVPS 24 {n} GB")).toBe(true);
    expect(isLanguageNeutral("Save")).toBe(false);
    expect(placeholdersOf("{count, plural, one {# x} other {{n} y}}")).toEqual(["count", "n"]);
  });
});
