import { viewerAddress } from "@tc/notify";
import type { WebConfig } from "./config.ts";

// Request guards of the web app: where a customer may be sent (U12), who may post (R9), and from
// which address a request came (the limits of R6).

/** U12: the only route prefixes a `next` value may lead to. */
export const NEXT_PREFIXES: readonly string[] = Object.freeze([
  "/dashboard",
  "/wallet",
  "/orders",
  "/servers",
  "/invoices",
  "/settings",
  "/support",
]);

const MAX_NEXT_LENGTH = 2048;
// A parse base that is never a real host: a value that leaves it was not a relative path.
const PARSE_BASE = "http://next.invalid";

function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * A relative path of the panel, normalised, or null. Refused: anything that is not text, is long,
 * holds a control character or a backslash, does not start with one "/", changes host when parsed,
 * or whose normalised path is not under a prefix of the list (so "/wallet/../admin" and "/walletx"
 * fail, and "/%2F%2Fevil.com" is not a prefix). The query is kept.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || hasControlOrBackslash(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  const path = url.pathname;
  const allowed = NEXT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return allowed ? `${path}${url.search}` : null;
}

/** The address of the viewer as CloudFront saw it. x-forwarded-for is never read: a client can forge it. */
export function clientIpOf(headers: Headers, config: WebConfig): string | null {
  const header = headers.get("cloudfront-viewer-address");
  if (header === null) return config.fakes ? "127.0.0.1" : null;
  return viewerAddress(header);
}

/** A state-changing request from a browser must name our own origin (R9; a second line next to Next's own check). */
export function assertSameOrigin(headers: Headers, config: WebConfig): boolean {
  if (headers.get("origin") !== config.appOrigin) return false;
  return headers.get("sec-fetch-site") !== "cross-site";
}

/** Eight hex characters: the reference a customer can quote from an error state, never a secret. */
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
