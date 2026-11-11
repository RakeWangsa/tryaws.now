import { describe, expect, it } from "vitest";
import { ipSubject, limitAddress, RETURN_LIMITS, START_LIMITS } from "../limits";
import { safeLog } from "../log";

describe("limits", () => {
  it("are the numbers of open point 8 and are frozen", () => {
    expect(START_LIMITS.customer).toEqual([
      { action: "eps.start", limit: 5, windowSeconds: 600 },
      { action: "eps.start.day", limit: 20, windowSeconds: 86400 },
    ]);
    expect(START_LIMITS.ip).toEqual({ action: "eps.start", limit: 20, windowSeconds: 3600 });
    expect(RETURN_LIMITS.ip).toEqual({ action: "eps.return", limit: 60, windowSeconds: 60 });
    expect(RETURN_LIMITS.payment).toEqual({ action: "eps.verify", limit: 1, windowSeconds: 5 });
    expect(Object.isFrozen(START_LIMITS)).toBe(true);
    expect(Object.isFrozen(START_LIMITS.customer)).toBe(true);
    expect(Object.isFrozen(START_LIMITS.customer[0])).toBe(true);
    expect(Object.isFrozen(RETURN_LIMITS.ip)).toBe(true);
  });
});

describe("ipSubject", () => {
  it("is 32 hex characters, stable, and different per address and key", () => {
    const a = ipSubject("k1", "203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(ipSubject("k1", "203.0.113.7")).toBe(a);
    expect(ipSubject("k1", "203.0.113.8")).not.toBe(a);
    expect(ipSubject("k2", "203.0.113.7")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("counts an IPv4-mapped address as its IPv4 and an IPv6 by its /64", () => {
    expect(limitAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("k", "2001:db8:1:2::1")).toBe(ipSubject("k", "2001:db8:1:2:ffff::9"));
    expect(ipSubject("k", "2001:db8:1:2::1")).not.toBe(ipSubject("k", "2001:db8:1:3::1"));
  });

  it("refuses anything that is not an address or has no key (R16)", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4, 5.6.7.8", "example.test", null, 5, undefined]) {
      expect(ipSubject("k", bad)).toBeNull();
    }
    expect(ipSubject("", "203.0.113.7")).toBeNull();
  });
});

describe("safeLog", () => {
  it("keeps only the allowed keys and scalar values, and never throws", () => {
    const lines: Array<Record<string, unknown>> = [];
    safeLog({ log: (_e, f) => lines.push(f) }, "eps.test", {
      paymentId: "p",
      state: "credited",
      reason: "x",
      count: 3,
      ok: true,
      xHash: "secret",
      url: "https://pg.eps.test",
      merchantTransactionId: "TCPabc",
      nested: { a: 1 },
    } as Record<string, unknown>);
    expect(lines).toEqual([{ paymentId: "p", state: "credited", reason: "x", count: 3, ok: true }]);
    expect(() =>
      safeLog(
        {
          log: () => {
            throw new Error("logger down");
          },
        },
        "eps.test",
        { ok: true },
      ),
    ).not.toThrow();
  });
});
