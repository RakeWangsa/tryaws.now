import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  englishOnlyTarget,
  isLocale,
  localeHrefs,
  localePath,
  splitLocale,
} from "./locales.ts";

describe("LOCALES", () => {
  it("lists bn first and defaults to bn", () => {
    expect(LOCALES).toEqual(["bn", "en"]);
    expect(DEFAULT_LOCALE).toBe("bn");
  });
});

describe("isLocale", () => {
  it("accepts bn and en and refuses fr and undefined", () => {
    expect(isLocale("bn")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("localePath", () => {
  it.each([
    // WPU-X19: only the home page is Bengali; every other path of bn is the English page.
    ["bn", "/x", "/en/x"],
    ["bn", "/pricing", "/en/pricing"],
    ["bn", "/login", "/en/login"],
    ["en", "/x", "/en/x"],
    ["en", "/", "/en"],
    ["bn", "/", "/"],
    ["en", "/dev/ui", "/en/dev/ui"],
  ] as const)("localePath(%s, %s) is %s", (locale, path, expected) => {
    expect(localePath(locale, path)).toBe(expected);
  });

  it.each(["x", "//evil.example", "/a?b=1", "/a#b", "/a\\b", "/a\nb", ""])(
    "localePath refuses %j",
    (path) => {
      expect(() => localePath("en", path)).toThrow(RangeError);
      expect(() => localePath("bn", path)).toThrow(RangeError);
    },
  );
});

describe("localeHrefs", () => {
  it("gives one href per locale", () => {
    expect(localeHrefs("/dev/ui")).toEqual({ bn: "/en/dev/ui", en: "/en/dev/ui" });
    expect(localeHrefs("/")).toEqual({ bn: "/", en: "/en" });
  });

  it("refuses a bad path", () => {
    expect(() => localeHrefs("//evil.example")).toThrow(RangeError);
  });
});

describe("splitLocale", () => {
  it.each([
    ["/en", "en", "/"],
    ["/en/x", "en", "/x"],
    ["/english", "bn", "/english"],
    ["/bn/x", "bn", "/bn/x"],
    ["/", "bn", "/"],
    ["/x", "bn", "/x"],
  ] as const)("splitLocale(%s) is %s and %s", (pathname, locale, path) => {
    expect(splitLocale(pathname)).toEqual({ locale, path });
  });
});

describe("englishOnlyTarget (WPU-X19)", () => {
  it.each([
    ["/", null],
    ["/bn", null],
    ["/bn/", null],
    ["/en", null],
    ["/en/pricing", null],
    ["/pricing", "/en/pricing"],
    ["/login", "/en/login"],
    ["/dashboard", "/en/dashboard"],
    ["/bn/pricing", "/en/pricing"],
    ["/bn/servers/new", "/en/servers/new"],
    ["/english", "/en/english"],
    ["/bnx", "/en/bnx"],
  ] as const)("englishOnlyTarget(%s) is %s", (pathname, expected) => {
    expect(englishOnlyTarget(pathname)).toBe(expected);
  });
});
