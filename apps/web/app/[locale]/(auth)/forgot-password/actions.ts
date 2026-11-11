"use server";

import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { requestResetCore } from "../../../../server/auth/request-reset.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** Ask for a reset code. Every address, known or not, ends on /reset-password. */
export async function requestResetAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => requestResetCore(ctx, formOf(data)));
}
