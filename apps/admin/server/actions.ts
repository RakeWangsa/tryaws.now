"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_ACCESS_COOKIE, requireAdmin } from "@tc/auth";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { ADMIN_ROLES } from "./sections.ts";
import { ensureAdminAuth, signIn, signOutAudit, userAgentOf, viewerAddressOf } from "./runtime.ts";
import type { SignInState } from "./state.ts";

// Thin Server Actions (R9 is inside makeSignIn). A "use server" file exports async functions only.

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

// The redirect target is a fixed path of the chosen locale (U12): nothing from the request decides it.
function localeOf(form: FormData) {
  const raw = text(form.get("locale"));
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

export async function signInAction(_previous: SignInState, form: FormData): Promise<SignInState> {
  const locale = localeOf(form);
  const answer = await signIn()({
    email: text(form.get("email")),
    password: text(form.get("password")),
    code: text(form.get("code")).replace(/\s+/g, ""),
    viewerAddress: await viewerAddressOf(),
    userAgent: await userAgentOf(),
  });
  if (!answer.ok) return { error: answer.code };
  // __Host-: Secure, Path=/, no Domain. The token is shown to nobody and logged nowhere.
  (await cookies()).set(ADMIN_ACCESS_COOKIE, answer.accessToken, {
    ...COOKIE_BASE,
    maxAge: answer.maxAgeSeconds,
  });
  redirect(localePath(locale, "/"));
}

export async function signOutAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  ensureAdminAuth();
  // Authenticate: only a signed-in admin signs out (any role).
  const actor = await requireAdmin([...ADMIN_ROLES]);
  await signOutAudit()({ adminId: actor.adminId, ip: actor.ip, userAgent: actor.userAgent });
  (await cookies()).set(ADMIN_ACCESS_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  redirect(localePath(locale, "/login"));
}
