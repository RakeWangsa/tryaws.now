"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, orderActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { placeOrderCore } from "../../../../../server/order-actions.ts";

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The idempotency key comes from the review page (one for each view), so a double click sends the
// same key twice and buys once (R7); the hash of the token is the second line of defence.
export async function placeOrderAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await placeOrderCore(
    await orderActionDeps(),
    pick(form, ["token", "idempotencyKey"]),
  );
  if (!result.ok) {
    if (result.error === "price_changed") return { error: "price_changed", draft: result.draft };
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  if (!ORDER_ID.test(result.orderId)) return { error: "unavailable" };

  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  redirect(localePath(locale, `/orders/${result.orderId}`));
}
