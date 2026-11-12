import { describe, expect, it } from "vitest";
import { checkedBackupWindow, checkedDomainName, checkedHealthPath } from "./console";

describe("checkedDomainName (certificate domain, R11)", () => {
  it("lower-cases a plain domain and trims it", () => {
    expect(checkedDomainName(" Shop.Example.COM ")).toBe("shop.example.com");
    expect(checkedDomainName("a-b.c1.co")).toBe("a-b.c1.co");
  });
  it("refuses anything that is not a plain dotted DNS name", () => {
    for (const bad of [
      "",
      "localhost",
      "*.example.com",
      "a b.com",
      "-x.com",
      "x-.com",
      "x..com",
      "exa_mple.com",
      "ex.com/path",
      "ex.com:80",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(130)}com`,
      5,
      null,
      undefined,
    ]) {
      expect(checkedDomainName(bad), String(bad)).toBeNull();
    }
  });
});

describe("checkedHealthPath", () => {
  it("accepts a path that starts with a slash", () => {
    for (const ok of ["/", "/health.html", "/a/b-c_d~e.f"]) expect(checkedHealthPath(ok)).toBe(ok);
  });
  it("refuses a query, a space, no leading slash, a long path and a non-string", () => {
    for (const bad of ["", "health", "/a?b=1", "/a b", "/a#x", `/${"a".repeat(100)}`, 5, null]) {
      expect(checkedHealthPath(bad), String(bad)).toBeNull();
    }
  });
});

describe("checkedBackupWindow", () => {
  it("accepts hh:mm-hh:mm of at least 30 minutes, also across midnight", () => {
    expect(checkedBackupWindow("16:00-16:30")).toBe("16:00-16:30");
    expect(checkedBackupWindow("23:30-00:30")).toBe("23:30-00:30");
  });
  it("refuses a short, malformed or impossible window", () => {
    for (const bad of [
      "16:00-16:29",
      "16:00-16:00",
      "24:00-01:00",
      "16:60-17:30",
      "1600-1700",
      "",
      5,
      null,
    ]) {
      expect(checkedBackupWindow(bad), String(bad)).toBeNull();
    }
  });
});
