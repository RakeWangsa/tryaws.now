import { parseDiskConfig } from "@tc/core";
import { publicErrorOf } from "./order-actions.ts";
import type { DraftActionResult, OrderActionDeps } from "./order-actions.ts";

// The core of the Server Action `addDisk` of the Storage tab (16.10). R9 in this order: authenticate,
// authorize (the ownership of the server and the flag `disk` are checked by the order code, through
// the customer's own repositories, R8 and R12), validate, rate limit, execute. The audit entry
// belongs to the placement: the draft writes no row (16.11 step 2), the customer reviews the price
// and pays on the order page. Nothing here calls AWS (R1). The ports are parameters, so the core
// runs in a test without a database. What leaves it is a fixed public key (U6).

const FAMILY = "disk";
const SIZE_TEXT = /^\d{1,5}$/;

function text(input: Record<string, unknown>, key: string): unknown {
  const value = input[key];
  return typeof value === "string" ? value.trim() : value;
}

/** The form sends the size as text. Only plain digits become a number; anything else stays invalid. */
function sizeOf(value: unknown): number {
  return typeof value === "string" && SIZE_TEXT.test(value) ? Number(value) : Number.NaN;
}

/**
 * /servers/[id] Storage: the form's fields, and nothing else, become the config of a disk (R11). A
 * customer id, an AWS name or any other field of the form is not read.
 */
export async function addDiskDraftCore(
  deps: OrderActionDeps,
  raw: unknown,
): Promise<DraftActionResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };

  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const parsed = parseDiskConfig({
    productId: text(input, "productId"),
    region: text(input, "region"),
    displayName: text(input, "displayName"),
    sizeGb: sizeOf(text(input, "sizeGb")),
    serverId: text(input, "serverId"),
  });
  if (!parsed.ok) {
    return { ok: false, error: "validation", ...(parsed.fields ? { fields: parsed.fields } : {}) };
  }

  if (deps.orders === null) return { ok: false, error: "unavailable" };
  let allowed: boolean;
  try {
    allowed = (await deps.rateLimit(session)).allowed;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!allowed) return { ok: false, error: "rate_limited" };

  // The server is the customer's own Linux server in the Region (R8) and the anchor row is the
  // active `disk` row of that Region: both are checked inside the order code.
  const result = await deps.orders.createOrderDraft(session, {
    family: FAMILY,
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
