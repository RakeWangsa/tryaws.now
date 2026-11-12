import { describe, expect, it } from "vitest";
import { checkWording, flatLeaves } from "../../../apps/web/messages/wording-check";
import { otpSmsText } from "../sms/otp-text";
import { BN, EN, SHARED } from "../templates/messages";

// WP9-T5: the email and SMS texts follow the same wording rules as the screens (U5, U6, 16.13,
// 16.14): bn and en have the same keys and placeholders, no empty text, no English left in bn, no
// AWS account id, ARN, raw AWS error or internal name, and the exact marks.
type Tree = Parameters<typeof checkWording>[0];
const tree = (value: unknown): Tree => value as Tree;
const show = (f: readonly { key: string; rule: string; text: string }[]): string[] =>
  f.map((x) => `${x.rule}  ${x.key}  ${x.text.slice(0, 90)}`);

describe("notify wording (WP9-T5)", () => {
  it("template catalogs: same keys, placeholders and wording rules in bn and en", () => {
    expect(show(checkWording(tree({ t: BN }), tree({ t: EN })))).toEqual([]);
    expect(flatLeaves(tree({ t: BN })).size).toBeGreaterThan(100);
  });

  it("shared footer texts: same keys and rules; statements of 16.13 stay unchanged", () => {
    const findings = checkWording(tree({ s: SHARED.bn }), tree({ s: SHARED.en }), {
      sameInBoth: [
        { key: "s.wordmark", reason: "brand" },
        { key: "s.trademark", reason: "16.13: the trademark line is English in both locales" },
        { key: "s.address", reason: "postal address of the company, in Latin" },
        { key: "s.regions.*", reason: "AWS Region names are shown in English in the shared text" },
      ],
    });
    expect(show(findings.filter((f) => !f.key.startsWith("s.regions.")))).toEqual([]);
    expect(SHARED.bn.awsShort).toBe("১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।");
    expect(SHARED.en.awsShort).toBe("100% AWS infrastructure. Built on Amazon Lightsail.");
  });

  it("OTP SMS text: both locales, no link, no AWS name, Bengali has Bengali script", () => {
    const bn = otpSmsText("bn", "beng", "123456", 5);
    const en = otpSmsText("en", "latn", "123456", 5);
    expect(bn).toMatch(/[ঀ-৿]/);
    for (const text of [bn, en]) {
      expect(text).not.toMatch(/https?:|AWS|Lightsail/);
    }
  });
});
