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
  | "prices_updating"
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

/**
 * Everything not listed (internal, upstream, not found, conflict) is "unavailable": it says nothing. One refusal of
 * pricing gets its own words (WPU-Y1): the USD to BDT rate is missing or older than 7 days, `upstream_unavailable`
 * with `data.code = "prices_updating"`. The customer reads that prices are being updated and to try later; nothing
 * about the rate, its age or who sets it.
 */
export function publicErrorOf(code: ErrorCode, data?: unknown): PublicError {
  if (
    code === "upstream_unavailable" &&
    (data as { code?: unknown } | undefined)?.code === "prices_updating"
  ) {
    return "prices_updating";
  }
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

/**
 * /servers/new: the form's fields, nothing else, become the config of an instance. The family is
 * an argument of the code, never a form field: the page of a Windows plan passes `windows_instance`
 * (behind its flag, R12, checked by the order code); the default is a Linux instance.
 */
export async function createOrderDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
  family: "linux_instance" | "windows_instance" = "linux_instance",
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const key = text(input, "keyPairId");
  // restoreToNewServer (16.10 Backups): a backup to start from. The order code reads it through the
  // customer's own repository; here it is only a well-formed id and never goes with a key pair.
  const restore = text(input, "restoreFromBackupId");
  const image = text(input, "blueprintId");
  const config = {
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    keyPairId: key === "" || key === undefined ? null : key,
    ...(image === "" || image === undefined ? {} : { blueprintId: image }),
    ...(restore === "" || restore === undefined ? {} : { restoreFromBackupId: restore }),
  };
  const parsed = parseInstanceConfig(config);
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }
  // WPU-G3 and G6, like the Lightsail console: a new Linux server needs an image and an SSH key. A
  // restore keeps the image and the keys of its backup, and Windows has its own flow. The order code
  // checks the image against the admin allow-list and the key against the customer (R8).
  if (family === "linux_instance" && parsed.value.restoreFromBackupId === undefined) {
    const missing: Record<string, string> = {};
    if (parsed.value.keyPairId === null) missing.keyPairId = "required";
    if (parsed.value.blueprintId === undefined) missing.blueprintId = "required";
    if (Object.keys(missing).length > 0) {
      return { ok: false, error: "validation", fields: missing };
    }
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  const result = await deps.orders.createOrderDraft(session, {
    family,
    config: { ...parsed.value },
  });
  if (!result.ok) {
    return {
      ok: false,
      error: publicErrorOf(result.error, result.data),
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
  return { ok: false, error: publicErrorOf(result.error, result.data) };
}
