"use server";

import { REFRESH_COOKIE } from "@tc/auth";
import { cookies } from "next/headers";
import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { signInCore } from "../../../../server/auth/sign-in.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** Sign in. The R9 order is in signInCore; this wrapper only supplies the request and applies the effects. */
export async function signInAction(_prev: FormState, data: FormData): Promise<FormState> {
  // WPU-X27: the refresh cookie of a signed-in customer signing in again, so the core can revoke it (L3).
  const previous = (await cookies()).get(REFRESH_COOKIE)?.value;
  return runAction((ctx) => signInCore(ctx, formOf(data), previous));
}
