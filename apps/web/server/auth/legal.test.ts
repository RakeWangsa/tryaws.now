import { describe, expect, it } from "vitest";
import { publicBn } from "../../messages/public-bn.ts";
import { publicEn } from "../../messages/public-en.ts";
import { LEGAL_VERSIONS } from "./legal.ts";

// WPU-Z8: a sign-up records the version of the texts it accepted (sign-up.ts). The version names the
// number and its date, the same as the version line of the legal pages, so the record says which text was
// shown. WPU-Y6 (owner, 2026-11-14): the texts are approved, so no version says "draft" any more.
const VERSION = /^(\d{4})-(\d{2})-(\d{2})-(\d+)$/;
const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
const bengali = (n: string): string => n.replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] as string);

describe("LEGAL_VERSIONS", () => {
  it("records version 3 of 15 November 2026 for each of the three documents", () => {
    expect(LEGAL_VERSIONS).toEqual({
      terms: "2026-11-15-3",
      acceptable_use: "2026-11-15-3",
      privacy: "2026-11-15-3",
    });
    for (const version of Object.values(LEGAL_VERSIONS)) expect(version).not.toMatch(/draft/i);
  });

  it("names the number and the date of the version line on the legal pages", () => {
    for (const version of Object.values(LEGAL_VERSIONS)) {
      const [, year, month, day, draft] = VERSION.exec(version) ?? [];
      expect(draft, version).toBeDefined();
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      const monthOf = (locale: string): string =>
        date.toLocaleString(locale, { month: "long", timeZone: "UTC" });
      expect(publicEn.Public.legal.version).toBe(
        `Version ${draft}, ${Number(day)} ${monthOf("en-GB")} ${year}`,
      );
      expect(publicBn.Public.legal.version).toBe(
        `সংস্করণ ${bengali(draft as string)}, ${bengali(String(Number(day)))} ${monthOf("bn")} ${bengali(year as string)}`,
      );
    }
  });
});
