import { currentCustomer } from "@tc/auth";
import type { ReturnInput } from "@tc/eps";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { writeLog } from "../../../server/log.ts";
import { clientIpOf, requestId } from "../../../server/request.ts";
import { getRuntime } from "../../../server/runtime.ts";

// The browser comes back from the payment gateway here. This file only reads the query, asks the
// package what a server-to-server verify says (R6), and sends the customer to a fixed screen. The
// query is untrusted: no value of it reaches the Location, a log line or a decision.

type Outcome = ReturnInput["outcome"];

const STATES = ["credited", "pending", "failed", "cancelled", "expired", "unknown"] as const;
const TARGET = new RegExp(`^(/wallet)\\?(topup=(?:${STATES.join("|")}))$`);

// Not for a cache, a crawler or a referrer: the URL carries a transaction id.
const SAFE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
};

/** A key that comes twice becomes an array; the object has no prototype, so `__proto__` is plain data. */
function queryOf(request: Request): ReturnInput["query"] {
  const query: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  let params: URLSearchParams;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    return query;
  }
  for (const [key, value] of params) {
    const seen = query[key];
    if (seen === undefined) query[key] = value;
    else if (typeof seen === "string") query[key] = [seen, value];
    else seen.push(value);
  }
  return query;
}

async function localeOfSession(): Promise<Locale> {
  try {
    const session = await currentCustomer();
    return session.ok ? session.value.locale : "bn";
  } catch {
    return "bn";
  }
}

function redirectTo(appOrigin: string, locale: Locale, target: string): Response {
  // Only one of our six targets is ever followed; anything else the package said becomes "unknown".
  const match = TARGET.exec(target) ?? TARGET.exec("/wallet?topup=unknown");
  const [, path, search] = match as RegExpExecArray;
  const location = new URL(`${localePath(locale, path as string)}?${search}`, appOrigin);
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: location.toString() },
  });
}

export async function handleReturnRequest(request: Request, outcome: Outcome): Promise<Response> {
  let runtime: Awaited<ReturnType<typeof getRuntime>>;
  try {
    runtime = await getRuntime();
  } catch {
    // No configuration, no origin to send anyone to: refuse (R16). The reference is for the log only.
    writeLog({ event: "eps.return", reason: "runtime", requestId: requestId() });
    return new Response(null, { status: 503, headers: SAFE_HEADERS });
  }
  const { config, eps } = runtime;

  const clientIp = clientIpOf(request.headers, config);
  let target: string;
  if (eps === null) {
    target = "/wallet?topup=unknown";
  } else if (clientIp === null) {
    // The package needs the address for its limits; nothing was asked, nothing is credited, the sweeper settles it.
    target = "/wallet?topup=pending";
  } else {
    try {
      const result = await eps.handleReturn({ outcome, query: queryOf(request), clientIp });
      target = typeof result?.redirectTo === "string" ? result.redirectTo : "";
    } catch {
      target = "/wallet?topup=pending";
    }
  }

  return redirectTo(config.appOrigin, await localeOfSession(), target);
}

/**
 * Next runs the GET handler for a HEAD request when no HEAD is exported, which would verify a
 * payment for a link preview. A HEAD is refused instead.
 */
export function handleHeadRequest(): Response {
  return new Response(null, { status: 405, headers: { ...SAFE_HEADERS, Allow: "GET" } });
}
