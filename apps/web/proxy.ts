import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { refreshForProxy } from "@tc/auth/proxy";
import type { RefreshOutcome } from "@tc/auth/proxy";
import { gatewayFormOrigins } from "@tc/eps/redirect";
import {
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_PATH,
  buildCsp,
  createNonce,
  englishOnlyTarget,
} from "@tc/ui/runtime";
import { routing } from "./i18n/routing.ts";
import { proxyAuthRuntime } from "./server/proxy-auth.ts";
import { indexableStage, robotsTagFor } from "./server/public/indexing.ts";

const handleI18n = createMiddleware(routing);

// The session refresh (WP2-T1 hand-over, open point 20). A Server Component cannot set a cookie, so
// the proxy refreshes an access token that is about to expire: the new cookies go on the request (so
// the render sees them) and on the response (so the browser keeps them). Any trouble is "none": the
// cookies stay as they are and the next verification decides what the request may do (R16).
async function refreshOf(request: NextRequest): Promise<RefreshOutcome> {
  try {
    const runtime = await proxyAuthRuntime(process.env);
    if (runtime === null) return { action: "none" };
    return await refreshForProxy(runtime, request);
  } catch {
    return { action: "none" };
  }
}

// One proxy per request (U4): the session refresh, a fresh nonce, the policy in report-only mode,
// and locale routing.
// The enforced `Content-Security-Policy` name is set on the REQUEST only: Next reads the nonce
// from it to put on its own scripts, and it is never sent to the browser (open point 12).
export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const refreshed = await refreshOf(request);
  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === "development",
    formActionOrigins: gatewayFormOrigins(),
  });

  const requestHeaders = new Headers(request.headers);
  if (refreshed.action !== "none") {
    if (refreshed.cookieHeader === "") requestHeaders.delete("cookie");
    else requestHeaders.set("cookie", refreshed.cookieHeader);
  }
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // WPU-X19 (owner, 2026-11-15): only the home page is Bengali. A request that would be served in bn
  // on any other page goes, with 308, to the same path under /en; only the pathname changes, so the
  // origin is the request's own and the query is kept (U12). The matcher below leaves out the API,
  // the payment return, robots, sitemap and every file.
  const english = englishOnlyTarget(request.nextUrl.pathname);
  let response: NextResponse;
  if (english === null) {
    response = handleI18n(new NextRequest(request, { headers: requestHeaders }));
  } else {
    const target = request.nextUrl.clone();
    target.pathname = english;
    response = NextResponse.redirect(target, 308);
  }

  if (refreshed.action !== "none") {
    // The strings come from @tc/auth (its names, its attributes); nothing is built here.
    for (const cookie of refreshed.setCookies) response.headers.append("set-cookie", cookie);
  }
  response.headers.set(CSP_REPORT_ONLY_HEADER, csp);
  response.headers.set("Reporting-Endpoints", `csp="${CSP_REPORT_PATH}"`);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Only the public pages may be indexed (16.8): the panel, the sign-in pages, the dev pages and
  // every path that is not a public page carry `noindex, nofollow` (server/public/indexing.ts).
  // WPU-Z16: on every stage but production, every path carries it.
  const robots = robotsTagFor(request.nextUrl.pathname, indexableStage(process.env));
  if (robots !== null) response.headers.set("X-Robots-Tag", robots);
  return response;
}

// The next-intl matcher: `/theme/...` and `/brand/...` hold a dot, so they are skipped. `/pay/...`
// is skipped too: the payment gateway returns there with a fixed URL, which a locale redirect or
// rewrite would break (the route handlers of app/pay/eps put the customer into the right locale).
// `/dev/idp/` and `/dev/sms/` are the two dev outbox routes of the fakes (they answer 404 outside
// the fake switches); they have no locale either.
export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|pay/|dev/(?:idp|sms)/|.*\\..*).*)",
};
