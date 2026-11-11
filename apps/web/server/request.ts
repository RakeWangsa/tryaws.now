import { viewerAddress } from "@tc/notify";
import type { WebConfig } from "./config.ts";

// Request guards of the web app: where a customer may be sent (U12), who may post (R9), and from
// which address a request came (the limits of R6).

// U12 lives in next-path.ts (no imports), so that a client component can use it without pulling
// the database through @tc/notify. Re-exported here for the callers that always had it from here.
export { NEXT_PREFIXES, safeNext } from "./next-path.ts";

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
