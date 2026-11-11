import { useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { localePath, type Locale } from "../runtime/index.ts";
import { ADMIN_NAV, visibleAdminNav } from "./nav.ts";
import { AccountMenu } from "./parts/AccountMenu.tsx";
import { AppFrame } from "./parts/AppFrame.tsx";
import { NavList } from "./parts/NavList.tsx";
import type { AdminNavId, AdminRole } from "./types.ts";

export interface AdminShellProps {
  locale: Locale;
  localeHrefs: Record<Locale, string>;
  currentId: AdminNavId;
  admin: { displayName: string; role: AdminRole };
  /** `null` shows every entry; a list shows the listed ids. */
  visibleIds: readonly AdminNavId[] | null;
  /** Default: `localePath(locale, entry.href)`. */
  navHref?: (id: AdminNavId) => string;
  /** The last item of the account menu, supplied by the app. */
  signOut?: ReactNode;
  children: ReactNode;
}

/** The operator console (16.12): the panel frame with the fixed OPS label and the admin navigation. */
export function AdminShell({
  locale,
  localeHrefs,
  currentId,
  admin,
  visibleIds,
  navHref,
  signOut,
  children,
}: AdminShellProps): ReactElement {
  const t = useTranslations("Shell");
  const items = visibleAdminNav(visibleIds);
  const hrefOf = (id: AdminNavId): string => {
    if (navHref !== undefined) return navHref(id);
    const entry = ADMIN_NAV.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new RangeError(`unknown navigation id ${id}`);
    return localePath(locale, entry.href);
  };
  return (
    <AppFrame
      locale={locale}
      localeHrefs={localeHrefs}
      homeHref={localePath(locale, "/")}
      navLabel={t("admin.navLabel")}
      nav={
        <NavList
          items={items}
          currentId={currentId}
          labelOf={(id) => t(`admin.nav.${id}`)}
          hrefOf={hrefOf}
          soonLabel={t("app.soon")}
        />
      }
      brandExtra={<span className="tc-ops-label">{t("admin.ops")}</span>}
      account={
        <AccountMenu
          label={t("app.account")}
          name={admin.displayName}
          detail={`${t("admin.signedInAs")} ${t(`admin.roles.${admin.role}`)}`}
          items={[]}
          footer={signOut}
        />
      }
    >
      {children}
    </AppFrame>
  );
}
