"use server";

import { guardAction, settingsActionDeps } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { changePasswordCore } from "../../../../../server/settings-actions.ts";

// The Server Action of /settings/security. The three passwords are read from the form, passed to the
// core and dropped: no state, no log and no answer ever holds one (R14). A failure leaves as a public
// error key and the field codes.
export async function changePasswordAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await changePasswordCore(
    await settingsActionDeps(),
    pick(form, ["currentPassword", "newPassword", "confirmPassword"]),
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: "changed" };
}
