import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { AppShell } from "@tc/ui";
import type { AppNavId } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import type { PanelData } from "../../../server/panel.ts";
import { SignOutForm } from "./sign-out.tsx";

/**
 * The customer shell of one page of the panel: top bar with the wallet chip, left navigation, slim
 * footer (16.7). The data comes from `requirePanel(path)`; later pages of the panel (servers,
 * dashboard, invoices) wrap their content in the same component and name their own `currentId`.
 */
export function PanelFrame({
  locale,
  currentId,
  panel,
  children,
}: {
  locale: Locale;
  /** The page's own path without locale. WPU-X19: the panel has no language switch, so it is not used now. */
  path: string;
  currentId: AppNavId;
  panel: PanelData;
  children: ReactNode;
}) {
  const t = useTranslations("Shell");
  return (
    <AppShell
      locale={locale}
      currentId={currentId}
      user={{ displayName: panel.displayName === "" ? t("app.account") : panel.displayName }}
      balanceMinor={panel.balanceMinor}
      enabledFamilies={panel.enabledFamilies}
      soonFamilies={panel.soonFamilies}
      {...(panel.unreadCount > 0 ? { unreadCount: panel.unreadCount } : {})}
      signOut={<SignOutForm locale={locale} />}
    >
      {children}
    </AppShell>
  );
}

/** The digits money and dates use on the panel: the market's in Bengali, Latin in English (16.13). */
export function numeralsFor(locale: Locale, panel: PanelData): "beng" | "latn" {
  return locale === "bn" ? panel.market.numerals : "latn";
}
