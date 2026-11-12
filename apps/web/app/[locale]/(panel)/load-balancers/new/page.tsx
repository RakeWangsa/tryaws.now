import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadLoadBalancerConfigurator } from "../../../../../server/load-balancers-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { createLoadBalancerDraftAction } from "./actions.ts";
import { LoadBalancerConfiguratorContent } from "./LoadBalancerConfiguratorContent.tsx";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("LoadBalancers.new.meta.title"), robots: { index: false, follow: false } };
}

/** /load-balancers/new (16.10, 16.11 step 1): the catalog rows the customer may buy, and their own servers as targets. */
export default async function NewLoadBalancerPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const panel = await startPanelPage("/load-balancers/new");
  const screen = await loadLoadBalancerConfigurator(panel.session, () => new Date());
  return (
    <PanelFrame locale={locale} path="/load-balancers/new" currentId="loadBalancers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("LoadBalancers.new.heading")}</h1>
      <LoadBalancerConfiguratorContent
        locale={locale}
        screen={screen}
        action={createLoadBalancerDraftAction}
      />
    </PanelFrame>
  );
}
