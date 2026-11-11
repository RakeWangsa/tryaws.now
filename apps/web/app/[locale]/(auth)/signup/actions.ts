"use server";

import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { signUpCore } from "../../../../server/auth/sign-up.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** Sign up. The R9 order is in signUpCore; this wrapper only supplies the request and applies the effects. */
export async function signUpAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => signUpCore(ctx, formOf(data)));
}
