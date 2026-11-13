import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INDEXNOW_ENDPOINT,
  findKey,
  main,
  payload,
  sitemapUrls,
} from "../../scripts/indexnow-ping.mjs";

// WPU-Z16: the IndexNow ping after a production deploy. The key is public by design; the URL list is
// the live sitemap; every failure ends the run with an error (R16).
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://tryaws.now/</loc></url>
<url><loc>https://tryaws.now/en</loc></url>
<url><loc>https://tryaws.now/pricing</loc></url>
<url><loc>https://tryaws.now/pricing</loc></url>
</urlset>`;

describe("IndexNow key file", () => {
  it("finds the one key file of apps/web/public, which holds its own key", () => {
    expect(findKey()).toMatch(/^[0-9a-f]{32}$/);
  });
  it("refuses a folder with no key file or a key file that holds another value", () => {
    const empty = mkdtempSync(join(tmpdir(), "indexnow-"));
    expect(() => findKey(empty)).toThrow(/found 0/);
    const wrong = mkdtempSync(join(tmpdir(), "indexnow-"));
    writeFileSync(join(wrong, `${"a".repeat(32)}.txt`), "b".repeat(32));
    expect(() => findKey(wrong)).toThrow(/does not hold its own key/);
  });
});

describe("IndexNow payload", () => {
  it("lists the sitemap URLs once each, in order", () => {
    expect(sitemapUrls(SITEMAP)).toEqual([
      "https://tryaws.now/",
      "https://tryaws.now/en",
      "https://tryaws.now/pricing",
    ]);
  });
  it("names the host, the key and the key file at the site root", () => {
    const key = "0123456789abcdef0123456789abcdef";
    expect(payload("https://tryaws.now", key, sitemapUrls(SITEMAP))).toEqual({
      host: "tryaws.now",
      key,
      keyLocation: `https://tryaws.now/${key}.txt`,
      urlList: ["https://tryaws.now/", "https://tryaws.now/en", "https://tryaws.now/pricing"],
    });
  });
  it("refuses an http origin, an empty list and a URL of another host", () => {
    const key = "0".repeat(32);
    expect(() => payload("http://tryaws.now", key, ["http://tryaws.now/"])).toThrow();
    expect(() => payload("https://tryaws.now", key, [])).toThrow(/no URL/);
    expect(() => payload("https://tryaws.now", key, ["https://evil.example/"])).toThrow(
      /not on tryaws.now/,
    );
  });
});

describe("IndexNow run", () => {
  const fake = (status) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/sitemap.xml")) {
        return { ok: true, status: 200, text: async () => SITEMAP };
      }
      return { ok: status < 300, status };
    };
    return { calls, fetchImpl };
  };
  it("posts JSON to api.indexnow.org and succeeds on 200 or 202", async () => {
    for (const status of [200, 202]) {
      const { calls, fetchImpl } = fake(status);
      const code = await main(["--origin", "https://tryaws.now"], fetchImpl, () => {});
      expect(code).toBe(0);
      expect(calls[1].url).toBe(INDEXNOW_ENDPOINT);
      expect(calls[1].init.method).toBe("POST");
      expect(JSON.parse(calls[1].init.body).urlList).toHaveLength(3);
    }
  });
  it("fails on any other answer, and posts nothing on --dry-run", async () => {
    const bad = fake(403);
    expect(await main(["--origin", "https://tryaws.now"], bad.fetchImpl, () => {})).toBe(1);
    const dry = fake(200);
    expect(
      await main(["--origin", "https://tryaws.now", "--dry-run"], dry.fetchImpl, () => {}),
    ).toBe(0);
    expect(dry.calls).toHaveLength(1);
  });
});
