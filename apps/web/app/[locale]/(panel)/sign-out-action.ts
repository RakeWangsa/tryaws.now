"use server";

import { REFRESH_COOKIE } from "@tc/auth";
import { cookies } from "next/headers";
import { formOf, runAction } from "../../../server/auth-wrap.ts";
import { signOutCore } from "../../../server/auth/sign-out.ts";

/**
 * Sign out of this device (open point 17). The refresh token is read through the constant of
 * @tc/auth (the name of the cookie is not repeated here) and sent to the core, which revokes it at
 * the provider on a best-effort basis and clears both cookies whatever the provider answers.
 */
export async function signOutAction(data: FormData): Promise<void> {
  const refresh = (await cookies()).get(REFRESH_COOKIE)?.value;
  const form = formOf(data);
  const locale = form["locale"] === "en" ? "en" : "bn";
  await runAction((ctx) => signOutCore(ctx, refresh, locale));
}
