import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadNotifications } from "../../../../server/extras-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { getRuntime } from "../../../../server/runtime.ts";
import { PanelFrame, numeralsFor } from "../PanelFrame.tsx";
import { markNotificationsReadAction } from "./actions.ts";
import { NotificationsContent } from "./NotificationsContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Notifications.meta.title"), robots: { index: false, follow: false } };
}

/** /notifications (16.10): the last 50 in-app notifications of the signed-in customer (R8). */
export default async function NotificationsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const panel = await startPanelPage("/notifications");
  const numerals = numeralsFor(locale, panel);
  const { config } = await getRuntime();
  const screen = await loadNotifications(panel.session, {
    locale,
    numerals,
    panelOrigin: config.appOrigin,
  });
  return (
    <PanelFrame locale={locale} path="/notifications" currentId="dashboard" panel={panel}>
      <NotificationsContent
        locale={locale}
        numerals={numerals}
        screen={screen}
        action={markNotificationsReadAction}
      />
    </PanelFrame>
  );
}
