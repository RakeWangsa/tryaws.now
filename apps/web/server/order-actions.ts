import { CLIENT_KEY, parseInstanceConfig } from "@tc/core";
import type { ErrorCode, OrderDraft, OrderSession, Orders } from "@tc/core";

// The cores of the Server Actions of the order flow. Each follows R9: authenticate, validate,
// rate limit, execute (the audit entry of a purchase is written inside the purchase transaction).
// Every port is a parameter, so the cores run in a test without a database or a request. What
// leaves a core is a fixed public key, never the text of an error, an id of AWS or a stack (U6).

export type PublicError =
  | "unauthenticated"
  | "forbidden"
  | "kyc_required"
  | "flag_off"
  | "limit_reached"
  | "validation"
  | "insufficient_balance"
  | "capacity_full"
  | "rate_limited"
  | "draft_expired"
  | "unavailable";

const PUBLIC_OF: Partial<Record<ErrorCode, PublicError>> = {
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  kyc_required: "kyc_required",
  flag_off: "flag_off",
  limit_reached: "limit_reached",
  validation: "validation",
  insufficient_balance: "insufficient_balance",
  capacity_full: "capacity_full",
  rate_limited: "rate_limited",
};

/** Everything not listed (internal, upstream, not found, conflict) is "unavailable": it says nothing. */
export function publicErrorOf(code: ErrorCode): PublicError {
  return PUBLIC_OF[code] ?? "unavailable";
}

export interface OrderActionDeps {
  /** The verified session of the request, or null (R16). */
  authenticate(): Promise<OrderSession | null>;
  /** One count against the draft limit of the customer; a failure to count is a refusal. */
  rateLimit(session: OrderSession): Promise<{ allowed: boolean }>;
  /** null = the order functions are not configured. */
  orders: Pick<Orders, "createOrderDraft" | "placeOrder"> | null;
}

export type DraftActionResult =
  { ok: true; token: string } | { ok: false; error: PublicError; fields?: Record<string, string> };

export type PlaceActionResult =
  | { ok: true; orderId: string }
  | {
      ok: false;
      error: "price_changed";
      draft: { token: string; totalMinor: string; expiresAt: string };
    }
  | { ok: false; error: PublicError; fields?: Record<string, string> };

/** 30 drafts a minute per customer; a draft writes nothing, but it reads and signs. */
export const DRAFT_RATE_LIMITS = Object.freeze([
  Object.freeze({ action: "order.draft", limit: 30, windowSeconds: 60 }),
]);

function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

/** /servers/new: the form's fields, nothing else, become the config of a Linux instance. */
export async function createOrderDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const key = text(input, "keyPairId");
  const config = {
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    keyPairId: key === "" || key === undefined ? null : key,
  };
  const parsed = parseInstanceConfig(config);
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed = false;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  const result = await deps.orders.createOrderDraft(session, {
    family: "linux_instance",
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error),
      ...(result.error === "validation" && result.fields ? { fields: result.fields } : {}),
    };
  }
  return { ok: true, token: result.value.token };
}

function isDraft(value: unknown): value is OrderDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Partial<OrderDraft>;
  return (
    typeof draft.token === "string" &&
    draft.expiresAt instanceof Date &&
    typeof draft.quote === "object" &&
    draft.quote !== null &&
    typeof draft.quote.totalMinor === "bigint"
  );
}

/** /orders/review: the draft token and the idempotency key of this page view. */
export async function placeOrderCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<PlaceActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const token = input["token"];
  const idempotencyKey = input["idempotencyKey"];
  const fields: Record<string, string> = {};
  if (typeof token !== "string" || token.length === 0 || token.length > 4096)
    fields["token"] = "invalid";
  if (typeof idempotencyKey !== "string" || !CLIENT_KEY.test(idempotencyKey)) {
    fields["idempotencyKey"] = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  const result = await deps.orders.placeOrder(session, {
    token: token as string,
    idempotencyKey: idempotencyKey as string,
  });
  if (result.ok) return { ok: true, orderId: result.value.orderId };

  if (result.error === "price_changed") {
    if (!isDraft(result.data)) return { ok: false, error: "unavailable" };
    return {
      ok: false,
      error: "price_changed",
      draft: {
        token: result.data.token,
        totalMinor: result.data.quote.totalMinor.toString(),
        expiresAt: result.data.expiresAt.toISOString(),
      },
    };
  }
  if (result.error === "validation" && result.fields?.["token"] === "expired") {
    return { ok: false, error: "draft_expired" };
  }
  return { ok: false, error: publicErrorOf(result.error) };
}
