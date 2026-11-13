import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../../server/panel-page.ts";
import { loadSupportThread } from "../../../../../../server/support-view.ts";
import { PanelFrame, numeralsFor } from "../../../PanelFrame.tsx";
import { addSupportMessageAction, closeSupportRequestAction } from "./actions.ts";
import { ThreadContent } from "./ThreadContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("SupportRequests.meta.threadTitle"), robots: { index: false, follow: false } };
}

/**
 * /support/requests/[id] (WPU-Z6): the thread of one request, the reply form and "Close request". The id
 * of another customer's request answers like a missing one (R8). The idempotency key of the reply form is
 * made here, once for each render of the form (R7).
 */
export default async function SupportThreadPage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const path = `/support/requests/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const thread = await loadSupportThread(panel.session, id);
  return (
    <PanelFrame locale={locale} path={path} currentId="support" panel={panel}>
      <ThreadContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        thread={thread}
        replyKey={newUuidV7()}
        replyAction={addSupportMessageAction}
        closeAction={closeSupportRequestAction}
      />
    </PanelFrame>
  );
}
