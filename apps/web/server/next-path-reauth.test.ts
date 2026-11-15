import { describe, expect, it } from "vitest";
import { reauthHref, safeNext } from "./next-path.ts";

// WPU-X20: the link of "please sign in again". The target is the page the customer was on, held to the U12
// allow-list; anything else leaves it out, and the flag only opens the login form (the rule is not weakened).
describe("reauthHref", () => {
  it("keeps the current panel page as next, without the locale prefix", () => {
    expect(reauthHref("en", "/en/dns/0190aaaa-0000-7000-8000-0000000000d1")).toBe(
      "/en/login?reauth=1&next=%2Fdns%2F0190aaaa-0000-7000-8000-0000000000d1",
    );
    expect(reauthHref("bn", "/bn/settings/security")).toBe(
      "/bn/login?reauth=1&next=%2Fsettings%2Fsecurity",
    );
  });
  it("drops a next that is not on the allow-list", () => {
    for (const bad of [
      "/en/admin/users",
      "//evil.com",
      "/en//evil.com",
      "/en/%2F%2Fevil.com",
      "",
    ]) {
      expect(reauthHref("en", bad), bad).toBe("/en/login?reauth=1");
    }
  });
  it("every produced next passes safeNext", () => {
    const href = reauthHref("en", "/en/containers/abc?tab=delete");
    const next = new URL(href, "http://x.invalid").searchParams.get("next");
    expect(safeNext(next)).toBe("/containers/abc?tab=delete");
  });
});
