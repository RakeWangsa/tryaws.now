import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../i18n/routing.ts";
import { loadLoadBalancerList } from "../../../../server/load-balancers-view.ts";
import { startPanelPage } from "../../../../server/panel-page.ts";
import { PanelFrame } from "../PanelFrame.tsx";
import { LoadBalancersContent } from "./LoadBalancersContent.tsx";

// Reads the session and the database: never prerendered, never cached.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("LoadBalancers.meta.title"), robots: { index: false, follow: false } };
}

/** /load-balancers (16.10): the customer's load balancers. */
export default async function LoadBalancersPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/load-balancers");
  const screen = await loadLoadBalancerList(panel.session);
  return (
    <PanelFrame locale={locale} path="/load-balancers" currentId="loadBalancers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("LoadBalancers.heading")}</h1>
      <LoadBalancersContent locale={locale} screen={screen} />
    </PanelFrame>
  );
}
