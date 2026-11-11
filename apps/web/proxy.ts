import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { gatewayFormOrigins } from "@tc/eps";
import { CSP_REPORT_ONLY_HEADER, CSP_REPORT_PATH, buildCsp, createNonce } from "@tc/ui/runtime";
import { routing } from "./i18n/routing.ts";

const handleI18n = createMiddleware(routing);

// One proxy per request (U4): a fresh nonce, the policy in report-only mode, and locale routing.
// The enforced `Content-Security-Policy` name is set on the REQUEST only: Next reads the nonce
// from it to put on its own scripts, and it is never sent to the browser (open point 12).
export default function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === "development",
    formActionOrigins: gatewayFormOrigins(),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = handleI18n(new NextRequest(request, { headers: requestHeaders }));

  response.headers.set(CSP_REPORT_ONLY_HEADER, csp);
  response.headers.set("Reporting-Endpoints", `csp="${CSP_REPORT_PATH}"`);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

// The next-intl matcher: `/theme/...` and `/brand/...` hold a dot, so they are skipped. `/pay/...`
// is skipped too: the payment gateway returns there with a fixed URL, which a locale redirect or
// rewrite would break (the route handlers of app/pay/eps put the customer into the right locale).
export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|pay/|.*\\..*).*)",
};
