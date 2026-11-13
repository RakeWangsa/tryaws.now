import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadContainerDetail } from "../../../../../server/container-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadAutoRenew } from "../../../../../server/auto-renew-view.ts";
import { AutoRenewSwitch } from "../../_family/AutoRenewSwitch.tsx";
import { setContainerAutoRenewAction } from "../../_family/auto-renew-actions.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { ContainerDetailContent } from "./ContainerDetailContent.tsx";
import {
  deployContainersAction,
  destroyContainerServiceAction,
  refreshContainerCertificateAction,
  removeContainerCertificateAction,
  replaceContainerCertificateAction,
  requestContainerCertificateAction,
  scheduleContainerPlanAction,
  setContainerEndpointAction,
} from "./actions.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Containers.detail.meta.title"), robots: { index: false, follow: false } };
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** /containers/[id] (16.10): header and tabs. The id of another customer's service answers like a missing one (R8). */
export default async function ContainerDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/containers/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const service = await loadContainerDetail(panel.session, id);
  // WPU-Z14: the auto-renew switch of the Overview tab (null: no own row, no subscription, flag off).
  const renew =
    service === null ? null : await loadAutoRenew(panel.session, "container_service", id);
  const tab = one(query["tab"]);
  return (
    <PanelFrame locale={locale} path={path} currentId="containers" panel={panel}>
      <ContainerDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        service={service}
        requestId={newUuidV7()}
        deployAction={deployContainersAction}
        destroyAction={destroyContainerServiceAction}
        planAction={scheduleContainerPlanAction}
        certRequestAction={requestContainerCertificateAction}
        certRefreshAction={refreshContainerCertificateAction}
        certRemoveAction={removeContainerCertificateAction}
        certReplaceAction={replaceContainerCertificateAction}
        endpointAction={setContainerEndpointAction}
        ids={{
          plan: newUuidV7(),
          planCancel: newUuidV7(),
          cert: newUuidV7(),
          certRefresh: newUuidV7(),
          certRemove: newUuidV7(),
          certReplace: newUuidV7(),
          endpoint: newUuidV7(),
          endpointRemove: newUuidV7(),
        }}
        {...(renew !== null
          ? { renewal: <AutoRenewSwitch action={setContainerAutoRenewAction} view={renew} /> }
          : {})}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}
