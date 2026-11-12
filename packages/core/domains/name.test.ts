import { describe, expect, it } from "vitest";
import { normalizeDomainName } from "./name";

const TLDS = ["com", "net", "co.uk", "uk", "shop"];

function ok(raw: unknown) {
  const r = normalizeDomainName(raw, TLDS);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.fields)}`);
  return r.value;
}
function why(raw: unknown): string | undefined {
  const r = normalizeDomainName(raw, TLDS);
  return r.ok ? undefined : r.fields?.name;
}

describe("normalizeDomainName", () => {
  it("lower-cases, trims and drops one trailing dot", () => {
    expect(ok("  Example.COM. ")).toEqual({
      name: "example.com",
      label: "example",
      tld: "com",
      idn: false,
    });
  });

  it("matches the longest listed suffix", () => {
    expect(ok("shop.co.uk")).toMatchObject({ label: "shop", tld: "co.uk" });
    expect(ok("shop.uk")).toMatchObject({ label: "shop", tld: "uk" });
  });

  it("converts an IDN to punycode and says so", () => {
    const v = ok("bücher.com");
    expect(v.name).toBe("xn--bcher-kva.com");
    expect(v.idn).toBe(true);
    expect(ok("xn--bcher-kva.com").idn).toBe(true);
  });

  it("refuses schemes, paths, ports, addresses, spaces and underscores", () => {
    for (const raw of [
      "http://example.com",
      "example.com/path",
      "example.com:80",
      "me@example.com",
      "exa mple.com",
      "ex_ample.com",
      "example.com?x=1",
      "*.example.com",
      "exa%6dple.com",
    ]) {
      expect(why(raw)).toBe("invalid");
    }
  });

  it("refuses wrong hyphens, empty labels and a missing TLD part", () => {
    for (const raw of ["-a.com", "a-.com", "ab--cd.com", "a..com", ".com", "com", "a.b.com"]) {
      expect(why(raw)).toBe("invalid");
    }
  });

  it("refuses a label over 63 characters and a name over 253", () => {
    expect(why(`${"a".repeat(64)}.com`)).toBe("label_too_long");
    expect(ok(`${"a".repeat(63)}.com`).label).toHaveLength(63);
    expect(why(`${"a.".repeat(130)}com`)).toBe("too_long");
  });

  it("refuses a TLD the table does not list", () => {
    expect(why("example.xyz")).toBe("tld_unsupported");
  });

  it("refuses non-strings and absurd input without echoing it", () => {
    expect(why(undefined)).toBe("invalid");
    expect(why(42)).toBe("invalid");
    expect(why("")).toBe("invalid");
    expect(why("x".repeat(400))).toBe("invalid");
    const r = normalizeDomainName("secret value.com", TLDS);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
