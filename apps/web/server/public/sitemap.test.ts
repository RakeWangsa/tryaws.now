import { describe, expect, it } from "vitest";
import { isPublicPath } from "./indexing.ts";
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data.js";
import { NEXT_PREFIXES } from "../next-path.ts";
import { AI_CRAWLERS, robotsFile, sitemapEntries, sitemapPaths } from "./sitemap.ts";
import type { PublicCatalog } from "./catalog.ts";

const ORIGIN = "https://cloud.example.test";
const catalog = (on: string[]): PublicCatalog => ({
  state: "ok",
  families: [],
  open: [],
  domainsOpen: false,
  flagOn: (key) => on.includes(key),
});

describe("sitemap.xml", () => {
  it("lists the public pages in both locales, each with hreflang alternates and an x-default", () => {
    const entries = sitemapEntries(ORIGIN, catalog([]));
    const pricingBn = entries.find((e) => e.url === `${ORIGIN}/pricing`);
    const pricingEn = entries.find((e) => e.url === `${ORIGIN}/en/pricing`);
    expect(pricingBn?.alternates.languages).toEqual({
      bn: `${ORIGIN}/pricing`,
      en: `${ORIGIN}/en/pricing`,
      "x-default": `${ORIGIN}/pricing`,
    });
    expect(pricingEn?.alternates).toEqual(pricingBn?.alternates);
    expect(entries.find((e) => e.url === `${ORIGIN}/`)).toBeDefined();
    expect(entries.find((e) => e.url === `${ORIGIN}/en`)).toBeDefined();
  });

  it("holds public pages only, no duplicate and every legal document", () => {
    const paths = sitemapPaths(catalog(["database"]));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(isPublicPath(path), path).toBe(true);
    for (const doc of ["terms", "privacy", "acceptable-use", "refund"]) {
      expect(paths).toContain(`/legal/${doc}`);
    }
  });

  it("lists a product family only while its flag is on (R12), and none when the flags cannot be read", () => {
    expect(sitemapPaths(catalog([]))).not.toContain("/products/databases");
    expect(sitemapPaths(catalog(["database"]))).toContain("/products/databases");
    expect(sitemapPaths(catalog(["database"]))).not.toContain("/products/cdn");
    expect(sitemapPaths({ state: "unavailable" })).not.toContain("/products/databases");
  });

  it("never lists the panel, the sign-in pages or the dev pages", () => {
    const text = JSON.stringify(sitemapEntries(ORIGIN, catalog(["database", "bucket", "cdn"])));
    for (const hidden of ["/dashboard", "/login", "/signup", "/servers", "/wallet", "/dev/"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });
});

describe("robots.txt", () => {
  it("allows the site, names the sitemap and keeps crawlers out of the panel and the sign-in pages, in both locales", () => {
    const file = robotsFile(ORIGIN);
    const all = file.rules[0]!;
    expect(all.userAgent).toBe("*");
    expect(file.sitemap).toBe(`${ORIGIN}/sitemap.xml`);
    expect(all.allow).toEqual(["/"]);
    for (const path of ["/login", "/en/login", "/dashboard", "/en/wallet", "/api/", "/dev/"]) {
      expect(all.disallow, path).toContain(path);
    }
    // Nothing public is disallowed.
    for (const path of [
      "/",
      "/pricing",
      "/help",
      "/support",
      "/legal/terms",
      "/products/cloud-servers",
    ]) {
      expect(
        all.disallow.some((p) => p !== "/" && path.startsWith(p)),
        path,
      ).toBe(false);
    }
  });
});

// WPU-Z16: robots.txt as Next writes it, read the way OmniRank's ai-allowlist gate and a crawler
// read it (a crawler with a group of its own ignores the `*` group).
describe("robots.txt for answer engines (WPU-Z16)", () => {
  // The 19 user agents of OmniRank v0.4.0 (gates/geo.py AI_CRAWLERS) and the ones the owner named.
  const OMNIRANK_AGENTS = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "anthropic-ai",
    "Claude-Web",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "Applebot-Extended",
    "Meta-ExternalAgent",
    "Amazonbot",
    "CCBot",
    "Bytespider",
    "Cohere-AI",
    "DuckAssistBot",
    "Diffbot",
    "YouBot",
    "PetalBot",
  ];
  const OWNER_AGENTS = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-User",
    "Claude-SearchBot",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "bingbot",
    "Applebot-Extended",
  ];

  const text = resolveRobots(robotsFile(ORIGIN));
  /** Groups of the file: consecutive User-Agent lines, then their rules. */
  const groups = (() => {
    const out: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
    let current: (typeof out)[number] | null = null;
    let inAgents = false;
    for (const line of text.split("\n")) {
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      const key = (field ?? "").trim().toLowerCase();
      if (key === "user-agent") {
        if (!inAgents) {
          current = { agents: [], allow: [], disallow: [] };
          out.push(current);
        }
        current!.agents.push(value.toLowerCase());
        inAgents = true;
      } else {
        inAgents = false;
        if (key === "allow") current?.allow.push(value);
        if (key === "disallow") current?.disallow.push(value);
      }
    }
    return out;
  })();
  const groupOf = (agent: string) =>
    groups.find((g) => g.agents.includes(agent.toLowerCase())) ??
    groups.find((g) => g.agents.includes("*"))!;

  it("names each crawler of the owner's list in a group of its own that allows the site", () => {
    expect([...AI_CRAWLERS].sort()).toEqual([...OWNER_AGENTS].sort());
    for (const agent of OWNER_AGENTS) {
      const group = groups.find((g) => g.agents.includes(agent.toLowerCase()));
      expect(group, agent).toBeDefined();
      expect(group!.allow, agent).toContain("/");
    }
  });

  it("blocks none of OmniRank's AI crawlers from the whole site (gate ai-allowlist)", () => {
    for (const agent of [...OMNIRANK_AGENTS, ...OWNER_AGENTS]) {
      expect(groupOf(agent).disallow, agent).not.toContain("/");
    }
  });

  it("keeps every crawler group out of the panel, the API, payment, dev and sign-in paths, in both locales", () => {
    for (const group of groups) {
      for (const prefix of [
        ...NEXT_PREFIXES.filter((p) => p !== "/support"),
        "/support/",
        "/api/",
        "/pay/",
        "/dev/",
        "/login",
      ]) {
        expect(group.disallow, `${group.agents[0]} ${prefix}`).toContain(prefix);
        expect(group.disallow, `${group.agents[0]} /en${prefix}`).toContain(`/en${prefix}`);
      }
      for (const path of sitemapPaths(catalog(["database", "bucket", "cdn"]))) {
        for (const url of [path, path === "/" ? "/en" : `/en${path}`]) {
          expect(
            group.disallow.some((p) => url === p || url.startsWith(p)),
            `${group.agents[0]} must not disallow ${url}`,
          ).toBe(false);
        }
      }
    }
  });

  it("names the sitemap of the origin", () => {
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });
});
