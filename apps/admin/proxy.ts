import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import {
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_PATH,
  adminEnglishTarget,
  buildCsp,
  createNonce,
} from "@tc/ui/runtime";
import { routing } from "./i18n/routing.ts";
import { adminGate } from "./server/gate.ts";

const handleI18n = createMiddleware(routing);

// Set on every request the proxy forwards. A request that carries it has been through locale routing
// already: it is the rewrite target (`/x` to `/bn/x`) coming back to the proxy, which next-intl would
// redirect to `/x` again, a 307 to the path the visitor asked for (WPU-T4). It is served as it is.
const PROXIED_HEADER = "x-tc-proxied";

// One proxy per request (U4): a fresh nonce, the policy in report-only mode, and locale routing.
// The enforced `Content-Security-Policy` name is set on the REQUEST only: Next reads the nonce
// from it to put on its own scripts, and it is never sent to the browser (open point 12).
export default function proxy(request: NextRequest): NextResponse {
  // First, before any locale work: an address outside the allowlist gets a bare 403 (6.2, R10). WAF is
  // the first wall; this is the second, for a request that reaches the function without passing it.
  if (!adminGate(request.headers.get("cloudfront-viewer-address"), process.env)) {
    return new NextResponse(null, {
      status: 403,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const nonce = createNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development" });

  const requestHeaders = new Headers(request.headers);
  const again = request.headers.has(PROXIED_HEADER);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set(PROXIED_HEADER, "1");

  // WPU-X22 (owner, 2026-11-15): the admin console is English only. Any path that would be served in
  // bn (`/`, `/x`, `/bn/x`) goes with 308 to the same path under /en; only the pathname changes on a
  // clone of the request URL, so the origin is the request's own and the query is kept (U12).
  const english = again ? null : adminEnglishTarget(request.nextUrl.pathname);
  let response: NextResponse;
  if (english !== null) {
    const target = request.nextUrl.clone();
    target.pathname = english;
    response = NextResponse.redirect(target, 308);
  } else if (again) {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    response = handleI18n(new NextRequest(request, { headers: requestHeaders }));
  }

  response.headers.set(CSP_REPORT_ONLY_HEADER, csp);
  response.headers.set("Reporting-Endpoints", `csp="${CSP_REPORT_PATH}"`);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

// The next-intl matcher: `/theme/...` and `/brand/...` hold a dot, so they are skipped.
export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
