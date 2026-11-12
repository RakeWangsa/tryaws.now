"use server";

import { revalidatePath } from "next/cache";
import { guardAction, settingsActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { updateBillingCore } from "../../../../../server/billing-actions.ts";
import {
  confirmEmailChangeCore,
  confirmPhoneChangeCore,
  startEmailChangeCore,
  startPhoneChangeCore,
  updateProfileCore,
} from "../../../../../server/settings-actions.ts";
import type { SettingsFailure } from "../../../../../server/settings-actions.ts";

// The Server Actions of /settings/profile. The origin check runs first; each core then runs R9
// (authenticate, authorize with the fresh sign-in, validate, rate limit, execute, audit). A failure
// leaves as a public error key and the field codes; nothing from the provider or the OTP service.

const failed = (result: SettingsFailure): FormState => ({
  error: result.error,
  ...(result.fields ? { fields: result.fields } : {}),
});

export async function updateProfileAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await updateProfileCore(
    await settingsActionDeps(),
    pick(form, ["name", "locale"]),
  );
  if (!result.ok) return failed(result);
  revalidatePath("/[locale]/settings/profile", "page");
  return { done: "saved", fields: { locale: result.locale } };
}

/** The billing details of the invoice buyer (WPU-I3). The customer comes from the session only (R8). */
export async function updateBillingAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await updateBillingCore(
    await settingsActionDeps(),
    pick(form, ["billingName", "billingAddress", "customerBin", "customerNid"]),
  );
  if (!result.ok) return failed(result);
  revalidatePath("/[locale]/settings/profile", "page");
  return { done: "saved" };
}

export async function startEmailChangeAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const input = pick(form, ["email"]);
  const result = await startEmailChangeCore(await settingsActionDeps(), input);
  if (!result.ok) return failed(result);
  // The address goes back to the form (the customer typed it) so the second step can confirm it.
  return { done: "codeSent", fields: { pendingEmail: input["email"] ?? "" } };
}

export async function confirmEmailChangeAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await confirmEmailChangeCore(
    await settingsActionDeps(),
    pick(form, ["email", "code"]),
  );
  if (!result.ok)
    return {
      ...failed(result),
      fields: { ...result.fields, pendingEmail: pick(form, ["email"])["email"] ?? "" },
    };
  revalidatePath("/[locale]/settings/profile", "page");
  return { done: "changed" };
}

export async function startPhoneChangeAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await startPhoneChangeCore(
    await settingsActionDeps(),
    pick(form, ["phone", "idempotencyKey"]),
  );
  if (!result.ok) return failed(result);
  return { done: "codeSent", fields: { phoneMasked: result.phoneMasked } };
}

export async function confirmPhoneChangeAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await confirmPhoneChangeCore(await settingsActionDeps(), pick(form, ["code"]));
  if (!result.ok) return failed(result);
  revalidatePath("/[locale]/settings/profile", "page");
  return { done: "changed" };
}
