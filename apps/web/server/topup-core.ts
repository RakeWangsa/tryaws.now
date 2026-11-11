import { AuthError } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { parseTopUpAmount } from "@tc/core";
import type { AmountFieldError, TopUpRange } from "@tc/core";
import { checkGatewayRedirect } from "@tc/eps";
import type { Eps, PublicState } from "@tc/eps";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { WebConfig } from "./config.ts";
import { assertSameOrigin, clientIpOf, safeNext } from "./request.ts";

// The cores of the two Server Actions of the top-up screens. The "use server" files are thin: they
// build the real dependencies and call these functions, so the order of R9 (authenticate, authorize,
// validate, rate limit, execute, audit) and the mapping of every result are testable without a
// database, a request or the gateway. No text of a dependency is ever put into a state (R14).

export type TopUpErrorCode = "rate_limited" | "unavailable" | "not_open" | "conflict" | "internal";

export type TopUpFormState =
  | { status: "idle"; idempotencyKey: string }
  | {
      status: "error";
      idempotencyKey: string;
      field?: { amount: AmountFieldError };
      code?: TopUpErrorCode;
      retryAfterSeconds?: number;
      requestId: string;
    };

export type RecheckState = {
  state: PublicState | "unknown";
  review: boolean;
  retryAfterSeconds?: number;
};

export interface ActionEnv {
  config: WebConfig;
  /** null = not configured: the screens say "not open yet" (R16). */
  eps: Eps | null;
  headers: Headers;
  locale: Locale;
}

export interface StartDeps {
  /** Throws AuthError when there is no session. */
  authenticate(): Promise<CustomerSession>;
  env(): Promise<ActionEnv>;
  /** The market range of this customer; null = the market is missing or inactive. */
  loadRange(session: CustomerSession): Promise<TopUpRange | null>;
  redirect(to: string): never;
  newKey(): string;
  newRequestId(): string;
  log(entry: Record<string, unknown>): void;
}

export interface RecheckDeps {
  authenticate(): Promise<CustomerSession>;
  env(): Promise<ActionEnv>;
  /** The stored status of one of this customer's payments; null = none. */
  readRow(session: CustomerSession, paymentId: string): Promise<{ status: string } | null>;
  log(entry: Record<string, unknown>): void;
}

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEV_CHECKOUT = "/dev/eps/checkout";
const DEV_QUERY = /^\?data=[A-Za-z0-9%._~-]{1,512}$/;

type Outcome = { redirectTo: string } | { state: TopUpFormState };

/** The Server Action `startTopUpAction` (R6, R7, R9, R14, R16). */
export async function runStartTopUp(
  deps: StartDeps,
  _previous: TopUpFormState,
  formData: FormData,
): Promise<TopUpFormState> {
  const outcome = await decide(deps, formData);
  if ("redirectTo" in outcome) return deps.redirect(outcome.redirectTo);
  return outcome.state;
}

async function decide(deps: StartDeps, formData: FormData): Promise<Outcome> {
  const requestId = deps.newRequestId();
  const rawKey = formData.get("idempotencyKey");
  const given = typeof rawKey === "string" && KEY.test(rawKey) ? rawKey : null;
  // The key of the page stays on every error that stored no payment; a state that may have left a
  // row behind gets a fresh key, so "Try again" is a new payment and not a replay (open point 18).
  const keep = given ?? deps.newKey();
  const error = (
    code: TopUpErrorCode,
    extra: { retryAfterSeconds?: number } = {},
    fresh = false,
  ): Outcome => ({
    state: {
      status: "error",
      idempotencyKey: fresh ? deps.newKey() : keep,
      code,
      requestId,
      ...extra,
    },
  });

  // 1. authenticate
  let session: CustomerSession;
  try {
    session = await deps.authenticate();
  } catch (caught) {
    if (caught instanceof AuthError && caught.code !== "upstream_unavailable") {
      const locale = await deps.env().then(
        (env) => env.locale,
        () => "bn" as Locale,
      );
      return { redirectTo: loginTarget(locale, "/wallet/topup") };
    }
    return error("unavailable");
  }

  // 2. authorize: our own origin, a configured gateway, a readable address
  let env: ActionEnv;
  try {
    env = await deps.env();
  } catch {
    deps.log({ event: "topup.start", reason: "config", requestId });
    return error("unavailable");
  }
  if (!assertSameOrigin(env.headers, env.config)) {
    deps.log({ event: "topup.start", reason: "origin", requestId });
    return error("unavailable");
  }
  if (env.eps === null) return error("not_open");
  const clientIp = clientIpOf(env.headers, env.config);
  if (clientIp === null) {
    deps.log({ event: "topup.start", reason: "address", requestId });
    return error("unavailable");
  }

  // 3. validate: a missing or bad key is replaced and the form shown again, never accepted
  if (given === null) return { state: { status: "idle", idempotencyKey: keep } };
  let range: TopUpRange | null;
  try {
    range = await deps.loadRange(session);
  } catch {
    deps.log({ event: "topup.start", reason: "unavailable", requestId });
    return error("unavailable");
  }
  if (range === null) return error("not_open");
  const parsed = parseTopUpAmount(formData.get("amount"), range);
  if (!parsed.ok) {
    return {
      state: { status: "error", idempotencyKey: keep, field: { amount: parsed.error }, requestId },
    };
  }

  // 4 and 5. rate limit, execute and audit happen inside startTopUp
  let result;
  try {
    result = await env.eps.startTopUp(
      session,
      { amountMinor: parsed.amountMinor, idempotencyKey: given },
      { clientIp },
    );
  } catch {
    deps.log({ event: "topup.start", reason: "exception", requestId });
    return error("internal", {}, true);
  }

  if (result.ok) return toGateway(deps, env, result.value, requestId, error);

  switch (result.error) {
    case "conflict":
      if (typeof result.ref === "string" && UUID.test(result.ref)) {
        return { redirectTo: localePath(env.locale, `/wallet/topup/${result.ref}`) };
      }
      return error("conflict", {}, true);
    case "rate_limited":
      return error("rate_limited", { retryAfterSeconds: secondsOf(result.data) ?? 60 });
    case "validation": {
      if (result.fields?.["amount"] === "out_of_range") {
        if (parsed.amountMinor < range.minMinor) {
          return {
            state: {
              status: "error",
              idempotencyKey: keep,
              field: { amount: "too_low" },
              requestId,
            },
          };
        }
        if (parsed.amountMinor > range.maxMinor) {
          return {
            state: {
              status: "error",
              idempotencyKey: keep,
              field: { amount: "too_high" },
              requestId,
            },
          };
        }
      }
      deps.log({ event: "topup.start", reason: "validation", requestId });
      return error("internal", {}, true);
    }
    case "forbidden":
    case "not_found":
      return error("not_open");
    case "upstream_unavailable":
      return error("unavailable", {}, true);
    case "unauthenticated":
      return { redirectTo: loginTarget(env.locale, "/wallet/topup") };
    default:
      deps.log({ event: "topup.start", reason: "internal", requestId });
      return error("internal", {}, true);
  }
}

function toGateway(
  deps: StartDeps,
  env: ActionEnv,
  value: { paymentId: string; redirectUrl: string },
  requestId: string,
  error: (code: TopUpErrorCode, extra?: { retryAfterSeconds?: number }, fresh?: boolean) => Outcome,
): Outcome {
  const checked = checkGatewayRedirect(value.redirectUrl);
  if (checked !== null) return { redirectTo: checked };
  if (env.config.fakes && value.redirectUrl.startsWith(`${DEV_CHECKOUT}?`)) {
    const query = value.redirectUrl.slice(DEV_CHECKOUT.length);
    if (DEV_QUERY.test(query)) {
      return { redirectTo: `${localePath(env.locale, DEV_CHECKOUT)}${query}` };
    }
  }
  // The row stays `redirected`; the sweeper settles it. The URL is not logged (R14).
  deps.log({ event: "eps.redirect_refused", paymentId: value.paymentId, requestId });
  return error("unavailable", {}, true);
}

function secondsOf(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const seconds = (data as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0
    ? seconds
    : null;
}

function loginTarget(locale: Locale, path: string): string {
  const next = safeNext(path);
  const base = localePath(locale, "/login");
  return next === null ? base : `${base}?next=${encodeURIComponent(next)}`;
}

/** The Server Action `recheckPaymentAction`: never an error text, only a state and perhaps a wait. */
export async function runRecheck(deps: RecheckDeps, paymentId: string): Promise<RecheckState> {
  const unknown: RecheckState = { state: "unknown", review: false };
  if (typeof paymentId !== "string" || !UUID.test(paymentId)) return unknown;

  let session: CustomerSession;
  try {
    session = await deps.authenticate();
  } catch {
    return unknown;
  }
  let env: ActionEnv;
  try {
    env = await deps.env();
  } catch {
    return unknown;
  }
  if (!assertSameOrigin(env.headers, env.config)) return unknown;

  // The state of the row as the customer's own repository sees it; pending when it cannot be read.
  const fromRow = async (extra: { retryAfterSeconds?: number } = {}): Promise<RecheckState> => {
    try {
      const row = await deps.readRow(session, paymentId);
      if (row === null) return unknown;
      return { state: publicOf(row.status), review: row.status === "review", ...extra };
    } catch {
      return { state: "pending", review: false, ...extra };
    }
  };

  const clientIp = clientIpOf(env.headers, env.config);
  if (env.eps === null || clientIp === null) return fromRow();

  let result;
  try {
    result = await env.eps.recheckPayment(session, paymentId, { clientIp });
  } catch {
    deps.log({ event: "topup.recheck", reason: "exception", paymentId });
    return fromRow();
  }
  if (result.ok) return { state: result.value.state, review: result.value.review };
  if (result.error === "not_found") return unknown;
  if (result.error === "rate_limited") {
    // Wait, then read the row again: a parallel check may have settled the payment already.
    return fromRow({ retryAfterSeconds: secondsOf(result.data) ?? 5 });
  }
  return fromRow();
}

function publicOf(status: string): PublicState {
  switch (status) {
    case "credited":
    case "failed":
    case "cancelled":
    case "expired":
      return status;
    default:
      return "pending";
  }
}
