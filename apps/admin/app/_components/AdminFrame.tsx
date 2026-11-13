import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { AdminShell, SubmitButton, type AdminNavId } from "@tc/ui";
import { localeHrefs, type Locale } from "@tc/ui/runtime";
import type { AdminActor } from "@tc/db";
import { segmentOf, visibleIdsFor } from "../../server/sections.ts";
import { signOutAction } from "../../server/actions.ts";

// One frame for every signed-in page: the AdminShell with the navigation of the role, the OPS label,
// the signed-in admin and the sign-out. The person is shown as a short id and the role, never an
// email (R14). `path` keeps the language switch on a page of its own inside a section (WPU-Z4:
// /operations/unpaid-rule, which roles open that cannot open /operations); default: the section.
export function AdminFrame({
  locale,
  admin,
  currentId,
  path,
  children,
}: {
  locale: Locale;
  admin: AdminActor;
  currentId: AdminNavId;
  path?: string;
  children: ReactNode;
}) {
  const t = useTranslations("Admin");
  return (
    <AdminShell
      locale={locale}
      localeHrefs={localeHrefs(path ?? `/${segmentOf(currentId)}`)}
      currentId={currentId}
      admin={{ displayName: `#${admin.adminId.slice(0, 8)}`, role: admin.role }}
      visibleIds={visibleIdsFor(admin.role)}
      signOut={
        <form action={signOutAction}>
          <input type="hidden" name="locale" value={locale} />
          <SubmitButton variant="tertiary" size="sm">
            {t("signOut")}
          </SubmitButton>
        </form>
      }
    >
      {children}
    </AdminShell>
  );
}
