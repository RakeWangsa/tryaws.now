import { describe, expect, it } from "vitest";
import { ipAllowed, parseCidr, parseViewerAddress } from "../admin-ip";

describe("parseViewerAddress (the CloudFront-Viewer-Address header)", () => {
  it("reads ip:port of IPv4", () => {
    expect(parseViewerAddress("198.51.100.10:46532")).toBe("198.51.100.10");
  });

  it("reads [ip]:port and ip:port of IPv6", () => {
    expect(parseViewerAddress("[2001:db8::1]:46532")).toBe("2001:db8::1");
    expect(parseViewerAddress("2001:db8::1:46532")).toBe("2001:db8::1");
  });

  it("refuses everything that is not an address with a port", () => {
    for (const v of [
      null,
      undefined,
      "",
      "198.51.100.10",
      "198.51.100.10:",
      "198.51.100.10:99999",
      "198.51.100.10:80:90",
      "999.1.1.1:80",
      "evil.example.com:80",
      "198.51.100.10:80, 203.0.113.1:80",
      " 198.51.100.10:80",
      "x".repeat(300),
    ]) {
      expect(parseViewerAddress(v as string | null | undefined), String(v)).toBeNull();
    }
  });
});

describe("parseCidr", () => {
  it("accepts IPv4 and IPv6 blocks and a single address", () => {
    expect(parseCidr("203.0.113.0/24")).not.toBeNull();
    expect(parseCidr("2001:db8::/32")).not.toBeNull();
    expect(parseCidr("203.0.113.7")).not.toBeNull();
    expect(parseCidr("2001:db8::7")).not.toBeNull();
  });

  it("refuses a bad prefix, a bad address and any other text", () => {
    for (const v of ["10.0.0.0/33", "10.0.0.0/-1", "::/129", "10.0.0/24", "a/b", "", "10.0.0.0/"]) {
      expect(parseCidr(v), v).toBeNull();
    }
  });
});

describe("ipAllowed", () => {
  const list = ["203.0.113.0/24", "198.51.100.7", "2001:db8:abcd::/48"];

  it("allows an address inside a listed block or equal to a listed address", () => {
    expect(ipAllowed("203.0.113.1", list)).toBe(true);
    expect(ipAllowed("203.0.113.255", list)).toBe(true);
    expect(ipAllowed("198.51.100.7", list)).toBe(true);
    expect(ipAllowed("2001:db8:abcd:1::5", list)).toBe(true);
  });

  it("refuses an address outside every block", () => {
    expect(ipAllowed("203.0.114.1", list)).toBe(false);
    expect(ipAllowed("198.51.100.8", list)).toBe(false);
    expect(ipAllowed("2001:db8:abce::1", list)).toBe(false);
    expect(ipAllowed("8.8.8.8", list)).toBe(false);
  });

  it("never lets an IPv4 address match an IPv6 block or the other way round", () => {
    expect(ipAllowed("0.0.0.1", ["::/0"])).toBe(false);
    expect(ipAllowed("::1", ["0.0.0.0/0"])).toBe(false);
  });

  it("an IPv4-mapped IPv6 address is read as its IPv4 address", () => {
    expect(ipAllowed("::ffff:203.0.113.9", list)).toBe(true);
    expect(ipAllowed("::ffff:8.8.8.8", list)).toBe(false);
  });

  it("fails closed: an empty list, an unparsable address or a bad entry allows nothing", () => {
    expect(ipAllowed("203.0.113.1", [])).toBe(false);
    expect(ipAllowed("not-an-ip", list)).toBe(false);
    expect(ipAllowed("", list)).toBe(false);
    expect(ipAllowed("203.0.113.1", ["garbage"])).toBe(false);
    expect(ipAllowed("203.0.113.1", ["garbage", "203.0.113.0/24"])).toBe(true);
    expect(ipAllowed(undefined as unknown as string, list)).toBe(false);
  });

  it("a /0 block allows every address of its family", () => {
    expect(ipAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["::/0"])).toBe(true);
  });
});
