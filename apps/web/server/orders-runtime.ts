import { makeOrders } from "@tc/core";
import type { Orders } from "@tc/core";
import { withTx } from "@tc/db";
import { envelopeOrders } from "./draft-envelope.ts";
import { assembleOrdersDeps } from "./orders-deps.ts";
import { getRuntime } from "./runtime.ts";

// The bound order functions of apps/web, built once on the first request (never at import) and kept
// on globalThis like the EPS services. null = not configured: the screens show the "not open" state
// and the actions refuse (R16).

export interface OrdersRuntime {
  readonly orders: Orders;
  /** The secrets verifyDraft needs on the review page. Never rendered, never logged. */
  readonly secrets: readonly Uint8Array[];
  readonly now: () => Date;
}

const KEY = "__tcOrdersRuntime";

export async function getOrdersRuntime(): Promise<OrdersRuntime | null> {
  const holder = globalThis as unknown as Record<string, OrdersRuntime | null | undefined>;
  const cached = holder[KEY];
  if (cached !== undefined) return cached;
  const { config } = await getRuntime();
  const clock = { now: () => new Date() };
  const deps = assembleOrdersDeps(config, process.env, { run: withTx, clock });
  // A missing secret is not cached as null: the next request tries again after a deploy fixed it.
  if (deps === null) return null;
  const runtime: OrdersRuntime = {
    // WPU-X10 review (U6): the browser gets only an envelope of the signed draft (draft-envelope.ts).
    orders: envelopeOrders(makeOrders(deps), deps.secrets),
    secrets: deps.secrets,
    now: clock.now,
  };
  holder[KEY] = runtime;
  return runtime;
}
