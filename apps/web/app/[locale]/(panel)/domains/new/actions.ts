"use server";

import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { createDomainDraftCore } from "../../../../../server/domain-actions.ts";
import { domainDraftDeps } from "../../../../../server/domain-deps.ts";

// R9 in this order: the origin, then the core (authenticate, validate with the typed confirmation, rate
// limit, seal the contact, execute). The draft writes no row (16.11 step 2). The fields of the form are
// the only input (R11).
export async function createDomainDraftAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await createDomainDraftCore(
    await domainDraftDeps(),
    pick(form, [
      "name",
      "confirmName",
      "contactType",
      "firstName",
      "lastName",
      "organizationName",
      "email",
      "phoneNumber",
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "countryCode",
      "zipCode",
    ]),
  );
  if (!result.ok)
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };

  const found = await getLocale();
  const locale: Locale = found === "en" ? "en" : "bn";
  // redirect() throws on purpose; nothing may catch it. The token is signed and holds only the sealed contact.
  redirect(`${localePath(locale, "/orders/review")}?d=${encodeURIComponent(result.token)}`);
}
