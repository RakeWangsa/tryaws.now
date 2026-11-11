import { describe, expect, it } from "vitest";
import { AuthError, toResult } from "../types";

describe("AuthError and toResult", () => {
  it("AuthError has a fixed message and exposes code and reason", () => {
    const e = new AuthError("forbidden", "suspended");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("auth: forbidden");
    expect(e.code).toBe("forbidden");
    expect(e.reason).toBe("suspended");
  });

  it("toResult maps an AuthError to its code", () => {
    expect(toResult(new AuthError("unauthenticated", "no_cookie"))).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(toResult(new AuthError("upstream_unavailable", "unavailable"))).toEqual({
      ok: false,
      error: "upstream_unavailable",
    });
  });

  it("toResult maps any other error to internal and keeps no message", () => {
    const r = toResult(new TypeError("token abc.def.ghi"));
    expect(r).toEqual({ ok: false, error: "internal" });
    expect(JSON.stringify(r)).not.toContain("abc.def.ghi");
    expect(toResult("string")).toEqual({ ok: false, error: "internal" });
    expect(toResult(undefined)).toEqual({ ok: false, error: "internal" });
  });
});
