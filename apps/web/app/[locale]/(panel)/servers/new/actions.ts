"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction, keyActionDeps, orderActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { createServerDraftCore } from "../../../../../server/wizard-key.ts";

// R9 in this order: the origin, then the core (authenticate, validate, rate limit, execute). The
// draft writes no row (16.11 step 2); the audit entry belongs to the placement. WPU-G10: like the
// Lightsail console, the wizard can also store a public key (made in the browser or pasted) and continue
// with its id; the private key is never a field of this form.
export async function createOrderDraftAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createServerDraftCore(
    await orderActionDeps(),
    keyActionDeps(),
    pick(form, [
      "productId",
      "region",
      "displayName",
      "keyPairId",
      "blueprintId",
      "keyMode",
      "newKeyName",
      "newKeyPublic",
    ]),
  );
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };

  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed, so the URL holds no secret.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(result.token)}`);
}
