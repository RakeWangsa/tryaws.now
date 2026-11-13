#!/usr/bin/env node
/* global URL, fetch, console */
// WPU-Z16: tell IndexNow (Bing, and through it Copilot and ChatGPT search) that the public pages of the
// site changed. Run after each production deploy (the job `indexnow` of .github/workflows/omnirank.yml)
// or by hand:
//
//   node scripts/indexnow-ping.mjs --origin https://tryaws.now [--dry-run]
//
// The key is PUBLIC by design (indexnow.org/documentation): it is the file name and the content of
// apps/web/public/<key>.txt, served at the site root. The list of URLs is the live sitemap.xml of the
// origin, so a page that is not public (or a product family whose flag is off) is never sent. Fail
// closed: a sitemap URL on another host, an empty sitemap or an answer other than 200 or 202 ends
// with exit code 1. Nothing secret is read or printed.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "public");
const KEY_FILE = /^([0-9a-f]{32})\.txt$/;

/** The one key file at the site root: its name is the key and its content is the key. */
export function findKey(dir = PUBLIC_DIR) {
  const keys = readdirSync(dir)
    .map((name) => KEY_FILE.exec(name))
    .filter((m) => m !== null);
  if (keys.length !== 1)
    throw new Error(`expected one IndexNow key file in ${dir}, found ${keys.length}`);
  const key = keys[0][1];
  const content = readFileSync(join(dir, `${key}.txt`), "utf8").trim();
  if (content !== key) throw new Error("the IndexNow key file does not hold its own key");
  return key;
}

/** The `<loc>` values of a sitemap, in order, without duplicates. */
export function sitemapUrls(xml) {
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  return [...new Set(urls)];
}

/** The POST body of indexnow.org: host, key, key location and the URLs, all on the origin's host. */
export function payload(origin, key, urls) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search !== "") {
    throw new Error("origin must be a plain https origin");
  }
  if (urls.length === 0) throw new Error("the sitemap lists no URL");
  if (urls.length > 10000) throw new Error("IndexNow takes at most 10000 URLs in one request");
  for (const url of urls) {
    if (new URL(url).host !== base.host) throw new Error(`a sitemap URL is not on ${base.host}`);
  }
  return {
    host: base.host,
    key,
    keyLocation: `${base.origin}/${key}.txt`,
    urlList: urls,
  };
}

function argValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

export async function main(args = process.argv.slice(2), fetchImpl = fetch, log = console.log) {
  const origin = argValue(args, "--origin");
  if (origin === undefined)
    throw new Error("usage: indexnow-ping.mjs --origin https://tryaws.now [--dry-run]");
  const key = findKey();
  const sitemap = await fetchImpl(new URL("/sitemap.xml", origin));
  if (!sitemap.ok) throw new Error(`sitemap.xml answered ${sitemap.status}`);
  const body = payload(origin, key, sitemapUrls(await sitemap.text()));
  // The key is public; the log still names only the counts.
  log(`indexnow: ${body.urlList.length} URLs of ${body.host}`);
  if (args.includes("--dry-run")) return 0;
  const res = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  log(`indexnow: answer ${res.status}`);
  // 200 submitted, 202 accepted while the key is checked. Anything else is a failure (R16).
  if (res.status !== 200 && res.status !== 202) return 1;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`indexnow: ${error.message}`);
      process.exit(1);
    },
  );
}
