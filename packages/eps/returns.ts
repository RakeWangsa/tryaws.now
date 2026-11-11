import type { EpsDeps } from "./deps";
import { parseMerchantTransactionId } from "./ids";
import { safeLog } from "./log";
import { EPS_MERCHANT_TRANSACTION_PARAM_NAMES } from "./protocol";
import type { PublicState } from "./state";
import { verifyPayment } from "./verify";

export const EPS_RETURN_PATHS = {
  success: "/pay/eps/success",
  fail: "/pay/eps/fail",
  cancel: "/pay/eps/cancel",
} as const;

/** The three return URLs EPS is given. An https origin only: no credentials, path, query or fragment. */
export function epsReturnUrls(baseUrl: string): {
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
} {
  if (typeof baseUrl !== "string") throw new TypeError("epsReturnUrls: the base is not text");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("epsReturnUrls: the base is not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new TypeError("epsReturnUrls: the base must be a plain https origin");
  }
  return {
    successUrl: url.origin + EPS_RETURN_PATHS.success,
    failUrl: url.origin + EPS_RETURN_PATHS.fail,
    cancelUrl: url.origin + EPS_RETURN_PATHS.cancel,
  };
}

export type ReturnOutcome = "success" | "fail" | "cancel";

export interface ReturnInput {
  outcome: ReturnOutcome;
  query: Readonly<Record<string, string | string[] | undefined>>;
  clientIp: string;
}

export interface ReturnResult {
  redirectTo: string;
  state: PublicState | "unknown";
}

// The only targets a return can lead to. No value of the query is ever part of one (no open redirect).
const TARGET: Readonly<Record<PublicState | "unknown", string>> = Object.freeze({
  credited: "/wallet?topup=credited",
  pending: "/wallet?topup=pending",
  failed: "/wallet?topup=failed",
  cancelled: "/wallet?topup=cancelled",
  expired: "/wallet?topup=expired",
  unknown: "/wallet?topup=unknown",
});

const result = (state: PublicState | "unknown"): ReturnResult => ({
  redirectTo: TARGET[state],
  state,
});

/** The one id of the query, or null when there is none, more than one, or it is not an id of ours. */
function idOf(query: ReturnInput["query"]): string | null {
  if (typeof query !== "object" || query === null) return null;
  const found: unknown[] = [];
  for (const name of EPS_MERCHANT_TRANSACTION_PARAM_NAMES) {
    if (!Object.hasOwn(query, name)) continue;
    const value = query[name];
    if (value === undefined) continue;
    found.push(value);
  }
  if (found.length !== 1) return null;
  return parseMerchantTransactionId(found[0]);
}

/**
 * The browser comes back from EPS. Pure of any HTTP type: the route passes the outcome (its name),
 * the query and the client address. The route name is logged and decides nothing: the answer is what
 * a server-to-server verify says about the one id (R6). Every query parameter but the id is ignored.
 */
export async function handleEpsReturn(deps: EpsDeps, input: ReturnInput): Promise<ReturnResult> {
  const outcome = input?.outcome;
  const route =
    outcome === "success" || outcome === "fail" || outcome === "cancel" ? outcome : "invalid";
  try {
    const id = idOf(input?.query);
    if (id === null) {
      safeLog(deps, "eps.return", { reason: "no_id", state: route });
      return result("unknown");
    }
    const verified = await verifyPayment(deps, id, { clientIp: input.clientIp });
    if (verified.ok) {
      safeLog(deps, "eps.return", { state: verified.value.state, reason: route });
      return result(verified.value.state);
    }
    // A forged or stale id is unknown. Anything that kept us from asking (limit, EPS down, our own
    // error) is told as pending: nothing was decided, nothing is credited, the sweeper settles it.
    const state = verified.error === "not_found" ? "unknown" : "pending";
    safeLog(deps, "eps.return", { state, reason: verified.error });
    return result(state);
  } catch {
    safeLog(deps, "eps.return", { reason: "exception" });
    return result("pending");
  }
}
