import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadLoadBalancerDetail } from "../../../../../server/load-balancers-view.ts";
import { getReaderPort } from "../../../../../server/reader-port.ts";
import { loadTargetHealth } from "../../../../../server/reader-reads-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { loadAutoRenew } from "../../../../../server/auto-renew-view.ts";
import { AutoRenewSwitch } from "../../_family/AutoRenewSwitch.tsx";
import { setLoadBalancerAutoRenewAction } from "../../_family/auto-renew-actions.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { CertificateChange } from "../../_console/CertificateChange.tsx";
import { LoadBalancerCertificate, LoadBalancerSettingsForm } from "../../_console/ConsoleForms.tsx";
import {
  destroyLoadBalancerAction,
  refreshCertificateAction,
  removeCertificateAction,
  replaceCertificateAction,
  requestCertificateAction,
  setLoadBalancerAttributesAction,
  setLoadBalancerTargetsAction,
} from "./actions.ts";
import { LoadBalancerDetailContent } from "./LoadBalancerDetailContent.tsx";

export const dynamic = "force-dynamic";

const EMPTY_CONSOLE = { healthCheckPath: null, httpsRedirect: null, certificate: null };

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("LoadBalancers.detail.meta.title"), robots: { index: false, follow: false } };
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** /load-balancers/[id] (16.10): header and tabs. The id of another customer's balancer answers like a missing one (R8). */
export default async function LoadBalancerDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/load-balancers/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const balancer = await loadLoadBalancerDetail(panel.session, id);
  // WPU-Z14: the auto-renew switch of the Overview tab (null: no own row, no subscription, flag off).
  const renew = balancer === null ? null : await loadAutoRenew(panel.session, "load_balancer", id);
  const tab = one(query["tab"]);
  // WPU-Y8: read once on page load, only for a balancer that exists for this customer (R8).
  const targetHealth =
    balancer === null
      ? undefined
      : await loadTargetHealth(
          panel.session,
          balancer.id,
          new Map(balancer.targets.map((x) => [x.id, x.name])),
          await getReaderPort(),
        );
  return (
    <PanelFrame locale={locale} path={path} currentId="loadBalancers" panel={panel}>
      <LoadBalancerDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        balancer={balancer}
        requestId={newUuidV7()}
        destroyAction={destroyLoadBalancerAction}
        targetsAction={setLoadBalancerTargetsAction}
        {...(targetHealth !== undefined ? { targetHealth } : {})}
        {...(balancer !== null && balancer.state === "active"
          ? {
              extra: (
                <>
                  <LoadBalancerSettingsForm
                    action={setLoadBalancerAttributesAction}
                    loadBalancerId={balancer.id}
                    requestId={newUuidV7()}
                    console={balancer.console ?? EMPTY_CONSOLE}
                  />
                  <hr />
                  <LoadBalancerCertificate
                    requestAction={requestCertificateAction}
                    refreshAction={refreshCertificateAction}
                    loadBalancerId={balancer.id}
                    requestId={newUuidV7()}
                    certificate={balancer.console?.certificate ?? null}
                  />
                  {balancer.console?.certificate != null ? (
                    <CertificateChange
                      removeAction={removeCertificateAction}
                      replaceAction={replaceCertificateAction}
                      idField="loadBalancerId"
                      resourceId={balancer.id}
                      removeRequestId={newUuidV7()}
                      replaceRequestId={newUuidV7()}
                      domain={balancer.console.certificate.domain}
                      allowed
                      loadBalancer
                    />
                  ) : null}
                </>
              ),
            }
          : {})}
        {...(renew !== null
          ? { renewal: <AutoRenewSwitch action={setLoadBalancerAutoRenewAction} view={renew} /> }
          : {})}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}
