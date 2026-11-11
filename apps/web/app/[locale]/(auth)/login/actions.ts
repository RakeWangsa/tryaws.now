"use server";

import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { signInCore } from "../../../../server/auth/sign-in.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** Sign in. The R9 order is in signInCore; this wrapper only supplies the request and applies the effects. */
export async function signInAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => signInCore(ctx, formOf(data)));
}
