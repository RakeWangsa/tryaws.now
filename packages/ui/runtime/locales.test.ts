import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
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
    ["bn", "/x", "/x"],
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
    expect(localeHrefs("/dev/ui")).toEqual({ bn: "/dev/ui", en: "/en/dev/ui" });
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
