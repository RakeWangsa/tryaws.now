import { useFormatter, useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { WalletChip } from "../components/WalletChip.tsx";
import { localePath, type Locale } from "../runtime/index.ts";
import { APP_NAV, visibleAppNav } from "./nav.ts";
import { AccountMenu } from "./parts/AccountMenu.tsx";
import { AppFrame } from "./parts/AppFrame.tsx";
import { NavList } from "./parts/NavList.tsx";
import type { AppNavId, ProductFamily } from "./types.ts";

export interface AppShellProps {
  locale: Locale;
  /** WPU-X19: the language switch is shown only when the hrefs are given (the home page). */
  localeHrefs?: Record<Locale, string> | undefined;
  currentId: AppNavId;
  user: { displayName: string };
  balanceMinor: bigint;
  enabledFamilies: readonly ProductFamily[];
  soonFamilies?: readonly ProductFamily[];
  unreadCount?: number;
  /** Default: `localePath(locale, entry.href)`. */
  navHref?: (id: AppNavId) => string;
  /** The last item of the account menu, supplied by the app. */
  signOut?: ReactNode;
  children: ReactNode;
}

/** The customer panel (16.7): top bar with wallet and bell, left navigation, slim footer. */
export function AppShell({
  locale,
  localeHrefs,
  currentId,
  user,
  balanceMinor,
  enabledFamilies,
  soonFamilies,
  unreadCount,
  navHref,
  signOut,
  children,
}: AppShellProps): ReactElement {
  const t = useTranslations("Shell");
  const format = useFormatter();
  const items = visibleAppNav(enabledFamilies, soonFamilies ?? []);
  const hrefOf = (id: AppNavId): string => {
    if (navHref !== undefined) return navHref(id);
    const entry = APP_NAV.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new RangeError(`unknown navigation id ${id}`);
    return localePath(locale, entry.href);
  };
  const unread = unreadCount ?? 0;
  return (
    <AppFrame
      locale={locale}
      localeHrefs={localeHrefs}
      homeHref={hrefOf("dashboard")}
      navLabel={t("app.navLabel")}
      nav={
        <NavList
          items={items}
          currentId={currentId}
          labelOf={(id) => t(`nav.${id}`)}
          hrefOf={hrefOf}
          soonLabel={t("app.soon")}
        />
      }
      topExtras={
        <>
          <WalletChip balanceMinor={balanceMinor} topUpHref={hrefOf("wallet")} />
          <a
            href={localePath(locale, "/notifications")}
            className="mergecolor text-nowrap"
            aria-label={t("app.notifications")}
          >
            <i className="fas fa-bell" aria-hidden="true" />
            {unread > 0 && <span className="badge bg-pink ms-1">{format.number(unread)}</span>}
          </a>
        </>
      }
      account={
        <AccountMenu
          label={t("app.account")}
          name={user.displayName}
          items={[
            { href: hrefOf("settings"), label: t("app.profile") },
            { href: localePath(locale, "/settings/security"), label: t("app.security") },
          ]}
          footer={signOut}
        />
      }
    >
      {children}
    </AppFrame>
  );
}
