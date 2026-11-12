"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, orderActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { createLoadBalancerDraftCore } from "../../../../../server/load-balancers-actions.ts";

// R9 in this order: the origin, then the core (authenticate, validate, rate limit, execute). The
// draft writes no row (16.11 step 2). The targets are checked against the customer's own servers
// inside the order code, through the scoped repository (R8). The four fields of the form are the only
// input: a certificate or a name for AWS is not read (R11).
export async function createLoadBalancerDraftAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const targetIds = form.getAll("targetIds").filter((v): v is string => typeof v === "string");
  const result = await createLoadBalancerDraftCore(await orderActionDeps(), {
    ...pick(form, ["productId", "region", "displayName"]),
    targetIds: targetIds.slice(0, 64),
  });
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };

  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed, so the URL holds no secret.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(result.token)}`);
}
