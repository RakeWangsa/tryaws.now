"use server";

import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, localePath } from "@tc/ui/runtime";
import { makeAdminsAction, type AdminsActionKind } from "./admins-flow.ts";
import { adminsFlowDeps, ensureAdminAuth } from "./runtime.ts";

// A thin Server Action (R9 is inside makeAdminsAction). A "use server" file exports async functions
// only. The kind comes from the form and is checked by the flow. The form has no actor or approver
// field: the acting admin is the verified session. The redirect target is fixed.
function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

export async function adminsAction(form: FormData): Promise<void> {
  const rawLocale = text(form.get("locale"));
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  ensureAdminAuth();
  const answer = await makeAdminsAction(adminsFlowDeps())({
    kind: text(form.get("kind")) as AdminsActionKind,
    id: text(form.get("id")),
    email: text(form.get("email")),
    role: text(form.get("role")),
    reason: text(form.get("reason")),
  });
  const result = answer.ok
    ? answer.directory === "failed"
      ? "directoryFailed"
      : answer.replayed
        ? "replayed"
        : "ok"
    : answer.code;
  redirect(`${localePath(locale, "/admins")}?result=${result}`);
}
