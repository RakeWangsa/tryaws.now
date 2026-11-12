import type { Clock } from "@tc/core";
import { formatEpsAmount } from "./amount";
import type {
  EpsCredentials,
  EpsGateway,
  InitializeRequest,
  InitializeResult,
  VerifyResult,
} from "./gateway";
import { epsHash } from "./hash";
import { EPS_BASE_URL, EPS_PATH } from "./protocol";
import { checkGatewayRedirect } from "./redirect";
import { readVerifyResponse } from "./status";

export interface HttpDeps {
  fetch: typeof fetch;
  clock: Clock;
  /** Per call, default 10 s. VERIFY (open point 6.8): EPS documents no timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TOKEN_MARGIN_MS = 60_000;
const VERIFY_RETRIES = 2;

/**
 * Fixed non-personal customer fields (open point 14). VERIFY (open point 6.9): EPS marks them mandatory;
 * if the sandbox rejects the placeholders the owner decides what a customer may send.
 */
const NEUTRAL_CUSTOMER = {
  customerName: "Customer",
  customerEmail: "no-reply@example.com",
  customerAddress: "Dhaka",
  customerCity: "Dhaka",
  customerState: "Dhaka",
  customerPostcode: "1000",
  customerCountry: "BD",
  customerPhone: "01000000000",
} as const;

interface Sent {
  status: number;
  body: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First present key of a record, so "token" and "Token" both work. */
function pick(o: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (o[n] !== undefined) return o[n];
  return undefined;
}

function nonEmptyText(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function hasErrorCode(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** EPS gives UTC without a zone and with 7 fractional digits; read it as UTC to the millisecond. NaN when unreadable. */
function parseExpire(v: unknown): number {
  if (typeof v !== "string") return NaN;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return NaN;
  const ms = (m[2] ?? "").slice(0, 3).padEnd(3, "0");
  return Date.parse(`${m[1]}.${ms}${m[3] ?? "Z"}`);
}

/**
 * The EPS client behind the port. fetch is injected. Every failure is a fixed reason: no URL with query,
 * no header and no body of a response is returned or thrown (R3, R14). It never throws.
 */
export function createEpsGateway(credentials: EpsCredentials, deps: HttpDeps): EpsGateway {
  const base = EPS_BASE_URL[credentials.mode];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  /** One HTTP call, bounded by AbortSignal.timeout, body read inside the same bound. null on any failure. */
  async function send(url: string, init: RequestInit): Promise<Sent | null> {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const timedOut = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
      timedOut.catch(() => undefined);
      const work = (async (): Promise<Sent> => {
        const res = await deps.fetch(url, { ...init, signal });
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        return { status: res.status, body };
      })();
      work.catch(() => undefined);
      return await Promise.race([work, timedOut]);
    } catch {
      return null;
    }
  }

  async function fetchToken(): Promise<string | null> {
    try {
      const r = await send(`${base}${EPS_PATH.token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hash": epsHash(credentials.hashKey, credentials.username),
        },
        body: JSON.stringify({ userName: credentials.username, password: credentials.password }),
      });
      if (r === null || r.status < 200 || r.status > 299 || !isRecord(r.body)) return null;
      if (hasErrorCode(pick(r.body, "errorCode", "ErrorCode"))) return null;
      const token = nonEmptyText(pick(r.body, "token", "Token"));
      if (token === null) return null;
      const now = deps.clock.now().getTime();
      const expires = parseExpire(pick(r.body, "expireDate", "ExpireDate"));
      // An unreadable expiry is not cached: the token serves this call only (fail closed on staleness).
      cached = { token, expiresAt: Number.isNaN(expires) ? now : expires - TOKEN_MARGIN_MS };
      return token;
    } catch {
      return null;
    }
  }

  async function getToken(): Promise<string | null> {
    if (cached !== null && deps.clock.now().getTime() < cached.expiresAt) return cached.token;
    if (inflight === null) {
      inflight = fetchToken().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  /**
   * An authorised call. On a 401 the token is refreshed once and the call repeated once; a second 401 is a failure.
   * Network errors and 5xx are repeated up to `retries` times (0 for InitializeEPS, which creates a transaction).
   */
  async function authed(
    build: (token: string) => { url: string; init: RequestInit },
    retries: number,
  ): Promise<Sent | null> {
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const token = await getToken();
      if (token === null) return null;
      const { url, init } = build(token);
      const r = await send(url, init);
      if (r !== null && r.status === 401) {
        cached = null;
        if (refreshed) return null;
        refreshed = true;
        continue;
      }
      if (r === null || r.status >= 500) {
        if (attempt < retries) {
          attempt += 1;
          continue;
        }
        return null;
      }
      return r;
    }
  }

  async function initialize(req: InitializeRequest): Promise<InitializeResult> {
    try {
      // formatEpsAmount throws on a non-positive amount: nothing is sent (R16).
      const amount = formatEpsAmount(req.totalAmountMinor);
      const hash = epsHash(credentials.hashKey, req.merchantTransactionId);
      const rest = JSON.stringify({
        merchantId: credentials.merchantId,
        storeId: credentials.storeId,
        CustomerOrderId: req.customerOrderId,
        merchantTransactionId: req.merchantTransactionId,
        transactionTypeId: 1, // VERIFY (open point 6.9): 1 = Web
        financialEntityId: 0,
        transitionStatusId: 0,
        ipAddress: req.ipAddress,
        version: "1",
        successUrl: req.successUrl,
        failUrl: req.failUrl,
        cancelUrl: req.cancelUrl,
        ...NEUTRAL_CUSTOMER,
        shippingMethod: "NO",
        noOfItem: "1",
        productName: req.productName,
        productProfile: "general",
        productCategory: "Wallet",
      });
      // The amount is written as text so it is 1500.00 and never passes through a JS float (R4).
      const body = `{"totalAmount":${amount},${rest.slice(1)}`;
      const r = await authed(
        (token) => ({
          url: `${base}${EPS_PATH.initialize}`,
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hash": hash,
              authorization: `Bearer ${token}`,
            },
            body,
          },
        }),
        0,
      );
      if (r === null || r.status < 200 || r.status > 299 || !isRecord(r.body))
        return { ok: false, reason: "unavailable" };
      if (hasErrorCode(pick(r.body, "ErrorCode", "errorCode")))
        return { ok: false, reason: "rejected" };
      // The .test host is accepted only outside production mode (WPU-D3).
      const redirectUrl = checkGatewayRedirect(
        pick(r.body, "RedirectURL", "redirectURL", "redirectUrl"),
        { allowTestHosts: credentials.mode !== "production" },
      );
      if (redirectUrl === null) return { ok: false, reason: "unavailable" };
      return {
        ok: true,
        redirectUrl,
        gatewayTransactionId: nonEmptyText(pick(r.body, "TransactionId", "transactionId")),
      };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async function verify(merchantTransactionId: string): Promise<VerifyResult> {
    try {
      const hash = epsHash(credentials.hashKey, merchantTransactionId);
      const r = await authed(
        (token) => ({
          url: `${base}${EPS_PATH.verify}?merchantTransactionId=${encodeURIComponent(merchantTransactionId)}`,
          init: { method: "GET", headers: { "x-hash": hash, authorization: `Bearer ${token}` } },
        }),
        VERIFY_RETRIES,
      );
      if (r === null || r.status < 200 || r.status > 299)
        return { ok: false, reason: "unavailable" };
      return { ok: true, reading: readVerifyResponse(r.body) };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return { initialize, verify };
}
