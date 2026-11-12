"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { setDomainAutoRenewCore } from "../../../../../server/domain-actions.ts";
import { domainActionDeps } from "../../../../../server/domain-deps.ts";

// The thin Server Action of the domain page (16.10): the origin check, the core (R9), and a FormState
// with a fixed key (U6).
export async function setDomainAutoRenewAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  const result = await setDomainAutoRenewCore(
    domainActionDeps(),
    pick(form, ["name", "requestId", "enabled"]),
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.done };
}
