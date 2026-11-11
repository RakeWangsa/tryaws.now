import { redirect } from "next/navigation";
import { currentAdmin } from "@tc/auth";
import type { AdminNavId } from "@tc/ui";
import { localePath, type Locale } from "@tc/ui/runtime";
import type { AdminActor } from "@tc/db";
import { ensureAdminAuth } from "./runtime.ts";
import { SECTION_ROLES } from "./sections.ts";

export type PageAdmin =
  { readonly kind: "ok"; readonly admin: AdminActor } | { readonly kind: "denied" };

// Steps 1 and 2 of R9 for a page: authenticate and authorize, with the roles of the section. No
// session sends the visitor to the sign-in; every other refusal (role, address, second factor, a
// disabled admin, a service that is down) shows the same neutral page, so the screen tells nothing
// about which check failed (R14, R16).
export async function loadPageAdmin(locale: Locale, id: AdminNavId): Promise<PageAdmin> {
  ensureAdminAuth();
  const result = await currentAdmin([...SECTION_ROLES[id]]);
  if (result.ok) return { kind: "ok", admin: result.value };
  if (result.error === "unauthenticated") redirect(localePath(locale, "/login"));
  return { kind: "denied" };
}
