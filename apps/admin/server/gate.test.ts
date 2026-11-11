import { describe, expect, it } from "vitest";
import { adminGate } from "./gate.ts";

const ENV = { ADMIN_IP_ALLOWLIST: "203.0.113.0/24, 2001:db8::/32", NODE_ENV: "production" };

describe("adminGate: the IP allowlist at the door (6.2)", () => {
  it("lets an address inside the list pass", () => {
    expect(adminGate("203.0.113.9:51234", ENV)).toBe(true);
    expect(adminGate("[2001:db8::7]:51234", ENV)).toBe(true);
  });

  it("outside the list, no header or an unreadable header is a refusal", () => {
    for (const v of ["198.51.100.1:80", null, undefined, "", "garbage", "203.0.113.9"]) {
      expect(adminGate(v, ENV), String(v)).toBe(false);
    }
  });

  it("fails closed without a list, with an empty list and with a list that has a bad entry", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { ADMIN_IP_ALLOWLIST: "", NODE_ENV: "production" },
      { ADMIN_IP_ALLOWLIST: "203.0.113.0/24, nonsense", NODE_ENV: "production" },
    ]) {
      expect(adminGate("203.0.113.9:80", env)).toBe(false);
    }
  });

  it("only `next dev` runs without a list; test and production do not", () => {
    expect(adminGate(undefined, { NODE_ENV: "development" })).toBe(true);
    expect(adminGate(undefined, { NODE_ENV: "test" })).toBe(false);
    expect(adminGate(undefined, { NODE_ENV: "production" })).toBe(false);
    expect(adminGate(undefined, {})).toBe(false);
  });

  it("a list set in development is still enforced", () => {
    const env = { NODE_ENV: "development", ADMIN_IP_ALLOWLIST: "203.0.113.0/24" };
    expect(adminGate("198.51.100.1:80", env)).toBe(false);
    expect(adminGate("203.0.113.1:80", env)).toBe(true);
  });
});
