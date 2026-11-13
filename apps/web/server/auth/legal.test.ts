import { describe, expect, it } from "vitest";
import { publicBn } from "../../messages/public-bn.ts";
import { publicEn } from "../../messages/public-en.ts";
import { LEGAL_VERSIONS } from "./legal.ts";

// WPU-Z8: a sign-up records the version of the texts it accepted (sign-up.ts). The version names the draft
// and its date, the same draft and date as the version line of the legal pages, so the record says which
// text was shown. The two move together when the texts change or are approved.
const VERSION = /^(\d{4})-(\d{2})-(\d{2})-draft-(\d+)$/;
const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
const bengali = (n: string): string => n.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] as string);

describe("LEGAL_VERSIONS", () => {
  it("records draft 1 of 13 November 2026 for each of the three documents", () => {
    expect(LEGAL_VERSIONS).toEqual({
      terms: "2026-11-13-draft-1",
      acceptable_use: "2026-11-13-draft-1",
      privacy: "2026-11-13-draft-1",
    });
  });

  it("names the draft and the date of the version line on the legal pages", () => {
    for (const version of Object.values(LEGAL_VERSIONS)) {
      const [, year, month, day, draft] = VERSION.exec(version) ?? [];
      expect(draft, version).toBeDefined();
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      const monthOf = (locale: string): string =>
        date.toLocaleString(locale, { month: "long", timeZone: "UTC" });
      expect(publicEn.Public.legal.version).toBe(
        `Version: draft ${draft}, ${Number(day)} ${monthOf("en-GB")} ${year}`,
      );
      expect(publicBn.Public.legal.version).toBe(
        `সংস্করণ: খসড়া ${bengali(draft as string)}, ${bengali(String(Number(day)))} ${monthOf("bn")} ${bengali(year as string)}`,
      );
    }
  });
});
