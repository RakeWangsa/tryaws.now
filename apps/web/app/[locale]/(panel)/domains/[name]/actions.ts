"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { setDomainAutoRenewCore } from "../../../../../server/domain-actions.ts";
import { domainActionDeps } from "../../../../../server/domain-deps.ts";
import {
  resendVerificationCore,
  setNameServersCore,
  type DomainOpsResult,
} from "../../../../../server/domain-ops.ts";

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

function stateOf(result: DomainOpsResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.done };
}

/** Asks the registry to send the owner's verification e-mail again (an operation row, R1). */
export async function resendVerificationAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await resendVerificationCore(domainActionDeps(), pick(form, ["name", "requestId"])),
  );
}

/** Asks for new name servers (an operation row, R1). The core needs the typed domain name. */
export async function setNameServersAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await setNameServersCore(
      domainActionDeps(),
      pick(form, ["name", "requestId", "nameServers", "confirmName"]),
    ),
  );
}
