import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadOrder } from "../../../../../server/servers-view.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { OrderStatusContent } from "./OrderStatusContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Orders.status.meta.title"), robots: { index: false, follow: false } };
}

/** /orders/[id] (16.11 step 6). Another customer's order answers like a missing one (R8). */
export default async function OrderPage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage(`/orders/${encodeURIComponent(id)}`);
  const order = await loadOrder(panel.session, id);
  return (
    <PanelFrame locale={locale} path={`/orders/${encodeURIComponent(id)}`} currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Orders.status.heading")}</h1>
      <OrderStatusContent locale={locale} order={order} />
    </PanelFrame>
  );
}
