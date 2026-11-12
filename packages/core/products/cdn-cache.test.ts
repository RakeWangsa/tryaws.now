import { describe, expect, it } from "vitest";
import { parseCachePolicy } from "./cdn-cache";

// WPU-G8: the cache behaviour of a distribution, default plus per-path. Every field is a closed list
// or a bounded number; nothing the customer types becomes an AWS name or tag (R11).

const good = {
  defaultBehavior: "cache",
  defaultTtl: 86400,
  minTtl: 0,
  maxTtl: 31536000,
  allowedMethods: "GET,HEAD",
  cachedMethods: "GET,HEAD",
  cookies: "none",
  headers: "none",
  queryStrings: "off",
  paths: "/images/*=cache\n*.php=dont-cache",
};

describe("parseCachePolicy", () => {
  it("builds the policy from the checked fields", () => {
    const out = parseCachePolicy(good);
    expect(out).toEqual({
      ok: true,
      value: {
        defaultBehavior: "cache",
        settings: {
          defaultTtl: 86400,
          minimumTtl: 0,
          maximumTtl: 31536000,
          allowedHttpMethods: "GET,HEAD",
          cachedHttpMethods: "GET,HEAD",
          cookies: "none",
          headers: "none",
          queryStrings: false,
        },
        paths: [
          { path: "images/*", behavior: "cache" },
          { path: "*.php", behavior: "dont-cache" },
        ],
      },
    });
  });

  it("accepts no paths and the wider method lists, and the string forms of a form", () => {
    const out = parseCachePolicy({
      ...good,
      defaultTtl: "60",
      minTtl: "0",
      maxTtl: "120",
      allowedMethods: "GET,HEAD,OPTIONS",
      cachedMethods: "GET,HEAD,OPTIONS",
      cookies: "all",
      headers: "all",
      queryStrings: "on",
      paths: "",
    });
    expect(out.ok && out.value.paths).toEqual([]);
    expect(out.ok && out.value.settings).toMatchObject({
      defaultTtl: 60,
      cookies: "all",
      headers: "all",
      queryStrings: true,
    });
  });

  it("refuses every value outside its list or range, naming the field", () => {
    const bads: [string, unknown][] = [
      ["defaultBehavior", "always"],
      ["defaultTtl", -1],
      ["defaultTtl", 1.5],
      ["defaultTtl", "1e3"],
      ["minTtl", 31536001],
      ["maxTtl", 99999999999],
      ["allowedMethods", "GET"],
      ["allowedMethods", "GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE ,x"],
      ["cachedMethods", "GET,HEAD,OPTIONS,PUT"],
      ["cookies", "allow-list"],
      ["headers", "Host"],
      ["queryStrings", "maybe"],
    ];
    for (const [field, value] of bads) {
      const out = parseCachePolicy({ ...good, [field]: value });
      expect(out, field).toMatchObject({
        ok: false,
        error: "validation",
        fields: { [field]: "invalid" },
      });
    }
  });

  it("refuses a minimum above the default or the default above the maximum", () => {
    expect(parseCachePolicy({ ...good, minTtl: 100, defaultTtl: 10 }).ok).toBe(false);
    expect(parseCachePolicy({ ...good, defaultTtl: 100, maxTtl: 10 }).ok).toBe(false);
  });

  it("forwarding all headers needs a minimum TTL of 0 (the AWS rule)", () => {
    expect(parseCachePolicy({ ...good, headers: "all", minTtl: 5 }).ok).toBe(false);
    expect(parseCachePolicy({ ...good, headers: "all", minTtl: 0 }).ok).toBe(true);
  });

  it("refuses bad, duplicate and too many path rules", () => {
    for (const paths of [
      "/a b=cache",
      "/a=maybe",
      "/a",
      "/a=cache\n/a=dont-cache",
      "/<script>=cache",
      "/" + "x".repeat(200) + "=cache",
      "/a?x=1=cache",
      Array.from({ length: 26 }, (_, i) => `/p${i}=cache`).join("\n"),
    ]) {
      expect(parseCachePolicy({ ...good, paths }), paths).toMatchObject({
        ok: false,
        fields: { paths: "invalid" },
      });
    }
  });

  it("reads a non-object as empty and refuses it", () => {
    expect(parseCachePolicy(null).ok).toBe(false);
    expect(parseCachePolicy("x").ok).toBe(false);
  });
});
