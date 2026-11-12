"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, orderActionDeps } from "../../../../server/action-deps.ts";
import { pick } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import { createDnsZoneDraftCore } from "../../../../server/dns-zone-actions.ts";

// R9 in this order: the origin, then the core (authenticate, validate with zod and the rule of the zone
// name, rate limit, execute). The draft writes no row (16.11 step 2). The two fields of the form are the
// only input (R11); the family is fixed in the core.
export async function createDnsZoneDraftAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createDnsZoneDraftCore(
    await orderActionDeps(),
    pick(form, ["zoneName", "declaredControl"]),
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed and holds the zone name only.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(result.token)}`);
}
