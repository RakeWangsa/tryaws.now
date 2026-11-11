"use server";

import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { resetPasswordCore } from "../../../../server/auth/reset-password.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** Set the new password with the emailed code. */
export async function resetPasswordAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => resetPasswordCore(ctx, formOf(data)));
}
