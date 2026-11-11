"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, orderActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { createCdnDraftCore } from "../../../../../server/cdn-actions.ts";

// R9 in this order: the origin, then the core (authenticate, validate, rate limit, execute). The
// draft writes no row (16.11 step 2); the audit entry belongs to the placement. The fields of the
// form are the only input: a domain or a certificate name is not read (R11).
export async function createCdnDraftAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createCdnDraftCore(
    await orderActionDeps(),
    pick(form, ["productId", "region", "displayName", "originId", "cacheBehavior"]),
  );
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };

  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed, so the URL holds no secret.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(result.token)}`);
}
