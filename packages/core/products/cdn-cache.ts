import type { Result } from "../types";

// The cache behaviour of a Lightsail distribution (WPU-G8): the default (cache or not), the cache
// settings (TTLs, HTTP methods, what is forwarded) and per-path rules. Pure. Every field is a closed
// list or a bounded number, so nothing the customer types becomes an AWS name or a tag key (R11);
// the path patterns are the only free text and they are limited to a small alphabet.

export type CacheBehavior = "cache" | "dont-cache";
export type ForwardChoice = "none" | "all";

export interface CachePolicy {
  readonly defaultBehavior: CacheBehavior;
  readonly settings: {
    readonly defaultTtl: number;
    readonly minimumTtl: number;
    readonly maximumTtl: number;
    readonly allowedHttpMethods: string;
    readonly cachedHttpMethods: string;
    readonly cookies: ForwardChoice;
    readonly headers: ForwardChoice;
    readonly queryStrings: boolean;
  };
  readonly paths: readonly { readonly path: string; readonly behavior: CacheBehavior }[];
}

export const CACHE_ALLOWED_METHODS = Object.freeze([
  "GET,HEAD",
  "GET,HEAD,OPTIONS",
  "GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE",
] as const);
export const CACHE_CACHED_METHODS = Object.freeze(["GET,HEAD", "GET,HEAD,OPTIONS"] as const);
export const MAX_CACHE_PATHS = 25;
export const MAX_TTL_SECONDS = 31_536_000; // one year

const BEHAVIORS: readonly string[] = ["cache", "dont-cache"];
const FORWARD: readonly string[] = ["none", "all"];
const PATH = /^[A-Za-z0-9._~\-/*]{1,100}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whole seconds from a number or a string of ASCII digits; null for anything else. */
function seconds(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^[0-9]{1,9}$/.test(v.trim())
        ? Number(v)
        : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_TTL_SECONDS ? n : null;
}

function parsePaths(v: unknown): { path: string; behavior: CacheBehavior }[] | null {
  if (v === undefined || v === null) return [];
  if (typeof v !== "string") return null;
  const out: { path: string; behavior: CacheBehavior }[] = [];
  const seen = new Set<string>();
  for (const line of v.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry === "") continue;
    const at = entry.lastIndexOf("=");
    if (at < 1) return null;
    // A leading slash is optional for the customer; the AWS documentation spells the patterns without.
    const path = entry.slice(0, at).trim().replace(/^\//, "");
    const behavior = entry.slice(at + 1).trim();
    if (!PATH.test(path) || !BEHAVIORS.includes(behavior) || seen.has(path)) return null;
    seen.add(path);
    out.push({ path, behavior: behavior as CacheBehavior });
    if (out.length > MAX_CACHE_PATHS) return null;
  }
  return out;
}

/**
 * The cache policy from a form or a payload. The field names of the errors are the form's. A policy
 * that AWS would refuse is refused here: minimum <= default <= maximum, and forwarding all headers
 * needs a minimum TTL of 0.
 */
export function parseCachePolicy(raw: unknown): Result<CachePolicy> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const defaultBehavior = input.defaultBehavior;
  if (typeof defaultBehavior !== "string" || !BEHAVIORS.includes(defaultBehavior)) {
    fields.defaultBehavior = "invalid";
  }
  const defaultTtl = seconds(input.defaultTtl);
  const minTtl = seconds(input.minTtl);
  const maxTtl = seconds(input.maxTtl);
  if (defaultTtl === null) fields.defaultTtl = "invalid";
  if (minTtl === null) fields.minTtl = "invalid";
  if (maxTtl === null) fields.maxTtl = "invalid";
  if (
    defaultTtl !== null &&
    minTtl !== null &&
    maxTtl !== null &&
    (minTtl > defaultTtl || defaultTtl > maxTtl)
  ) {
    fields.defaultTtl = "invalid";
  }
  const allowed = input.allowedMethods;
  if (
    typeof allowed !== "string" ||
    !(CACHE_ALLOWED_METHODS as readonly string[]).includes(allowed)
  ) {
    fields.allowedMethods = "invalid";
  }
  const cached = input.cachedMethods;
  if (typeof cached !== "string" || !(CACHE_CACHED_METHODS as readonly string[]).includes(cached)) {
    fields.cachedMethods = "invalid";
  }
  const cookies = input.cookies;
  if (typeof cookies !== "string" || !FORWARD.includes(cookies)) fields.cookies = "invalid";
  const headers = input.headers;
  if (typeof headers !== "string" || !FORWARD.includes(headers)) fields.headers = "invalid";
  if (headers === "all" && minTtl !== null && minTtl !== 0) fields.minTtl = "invalid";
  const qs = input.queryStrings;
  if (qs !== "on" && qs !== "off") fields.queryStrings = "invalid";
  const paths = parsePaths(input.paths);
  if (paths === null) fields.paths = "invalid";

  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      defaultBehavior: defaultBehavior as CacheBehavior,
      settings: {
        defaultTtl: defaultTtl as number,
        minimumTtl: minTtl as number,
        maximumTtl: maxTtl as number,
        allowedHttpMethods: allowed as string,
        cachedHttpMethods: cached as string,
        cookies: cookies as ForwardChoice,
        headers: headers as ForwardChoice,
        queryStrings: qs === "on",
      },
      paths: paths as { path: string; behavior: CacheBehavior }[],
    },
  };
}
