import type { ReactNode } from "react";
import {
  Button,
  Card,
  CopyField,
  EmptyState,
  StatTile,
  Tabs,
  formatDate,
  formatMoney,
} from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { CdnDetail } from "../../../../../server/cdn-view.ts";
import { CdnState, useOriginLabel } from "../CdnParts.tsx";
import {
  CacheBehaviorForm,
  CertificatePanel,
  OriginForm,
  PlanChangeForm,
} from "../../_console/PlanAndCertForms.tsx";
import { DestroyPanel, EnabledForm } from "./CdnForms.tsx";

// The content of /cdn/[id] (16.10): a header and the tabs Overview, Settings and Delete. A
// distribution of another customer and a missing one give the same answer (R8). The default domain
// is shown because the customer needs it (U6); nothing here shows an account id, an ARN or a
// generated AWS name (R11).

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** One request id for each form of the page (R7): two forms never share an idempotency key. */
export interface CdnFormIds {
  cache: string;
  origin: string;
  plan: string;
  planCancel: string;
  cert: string;
  certRefresh: string;
  certRemove: string;
  certReplace: string;
}

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });

export function CdnDetailContent({
  locale,
  numerals,
  cdn,
  requestId,
  enabledAction = refuse,
  destroyAction = refuse,
  cacheAction = refuse,
  originAction = refuse,
  planAction = refuse,
  certRequestAction = refuse,
  certRefreshAction = refuse,
  certRemoveAction = refuse,
  certReplaceAction = refuse,
  ids,
  defaultTab,
  extra = null,
  renewal = null,
}: {
  locale: Locale;
  numerals: Numerals;
  cdn: CdnDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  enabledAction?: Action;
  destroyAction?: Action;
  /** WPU-G8: cache behaviour, origin, plan at the next renewal, custom domain and certificate. */
  cacheAction?: Action;
  originAction?: Action;
  planAction?: Action;
  certRequestAction?: Action;
  certRefreshAction?: Action;
  certRemoveAction?: Action;
  certReplaceAction?: Action;
  ids?: CdnFormIds;
  defaultTab?: string;
  /** The cache flush form (WPU-G7), built by the page. */
  extra?: ReactNode;
  /** WPU-Z14: the auto-renew switch, built by the page; shown at the end of the Overview tab. */
  renewal?: ReactNode;
}) {
  const t = useTranslations("Cdn");
  const tc = useTranslations("Console");
  const originLabel = useOriginLabel();
  const listHref = localePath(locale, "/cdn");

  if (cdn === null) {
    // WPU-Z14: with the flag of the family off the page has no detail, but an "off only" auto-renew switch
    // (built by the page while auto-renew is still on) lets the customer stop the renewals.
    return (
      <>
        <EmptyState
          title={t("detail.notFound.title")}
          description={t("detail.notFound.body")}
          action={
            <Button variant="primary" href={listHref}>
              {t("detail.back")}
            </Button>
          }
        />
        {renewal}
      </>
    );
  }

  const overview = (
    <div className="row g-3">
      <div className="col-12 col-md-6">
        <StatTile
          value={originLabel(cdn.originName, cdn.originKind)}
          description={t("detail.overview.origin")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={t(`cache.${cdn.cacheBehavior}`)}
          description={t("detail.overview.cache")}
        />
      </div>
      <div className="col-12 col-md-6">
        {cdn.defaultDomain === null ? (
          <StatTile value={t("list.none")} description={t("detail.overview.domainPending")} />
        ) : (
          <CopyField
            label={t("detail.overview.domain")}
            value={cdn.defaultDomain}
            hint={t("detail.overview.domainHint")}
          />
        )}
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={t("detail.overview.locationValue")}
          description={t("detail.overview.location")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(cdn.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
    </div>
  );

  // Off from active, on from stopped; every other state belongs to the lifecycle (R13).
  const switchable = cdn.state === "active" || cdn.state === "stopped";
  const settings = (
    <>
      <h3 className="mergecolor h4">{t("detail.switch.title")}</h3>
      <EnabledForm
        action={enabledAction}
        cdnId={cdn.id}
        requestId={requestId}
        enabled={cdn.state !== "stopped"}
        allowed={switchable}
      />
      {extra === null ? null : <div className="mt-4">{extra}</div>}
    </>
  );

  const money = (minor: bigint) => formatMoney(minor, { locale, numerals });
  const bundleName = (bundle: string): string =>
    t(`plan.${bundle === "small_1_0" ? "small" : bundle === "medium_1_0" ? "medium" : "large"}`);
  const planNameOf = (id: string | null): string | null => {
    const found = id === null ? undefined : cdn.plans?.find((p) => p.id === id);
    return found === undefined ? null : bundleName(found.bundle);
  };
  const pending = cdn.pendingProductId;
  const pendingPlan = pending === null ? undefined : cdn.plans?.find((p) => p.id === pending);
  const live = cdn.state === "active" || cdn.state === "stopped" || cdn.state === "suspended";

  const cache = (
    <CacheBehaviorForm
      action={cacheAction}
      cdnId={cdn.id}
      requestId={ids?.cache ?? requestId}
      policy={cdn.cachePolicy}
      allowed={cdn.state === "active"}
    />
  );
  const origin = (
    <OriginForm
      action={originAction}
      cdnId={cdn.id}
      requestId={ids?.origin ?? requestId}
      currentName={originLabel(cdn.originName, cdn.originKind)}
      allowed={cdn.state === "active"}
      choices={cdn.origins
        .filter((o) => o.id !== cdn.originId)
        .map((o) => ({
          id: o.id,
          label: `${tc(`origin.${o.kind}`)}${o.name === "" ? "" : `: ${o.name}`}`,
        }))}
    />
  );
  const plan = (
    <PlanChangeForm
      action={planAction}
      idField="cdnId"
      resourceId={cdn.id}
      requestId={ids?.plan ?? requestId}
      cancelRequestId={ids?.planCancel ?? requestId}
      kind="cdn"
      currentName={planNameOf(cdn.currentProductId)}
      renewsText={
        cdn.renewsAt === null
          ? null
          : tc("plan.renews", { date: formatDate(cdn.renewsAt, { locale, numerals }) })
      }
      pendingText={
        pending === null
          ? null
          : pendingPlan === undefined
            ? tc("plan.pendingGone")
            : tc("plan.pending", {
                name: bundleName(pendingPlan.bundle),
                price: money(pendingPlan.priceMinor),
              })
      }
      hasPending={pending !== null}
      pendingFailed={cdn.pendingFailed}
      state={!live ? "inactive" : cdn.plans === null ? "unpriced" : "ready"}
      choices={(cdn.plans ?? [])
        .filter((p) => p.id !== cdn.currentProductId)
        .map((p) => ({
          id: p.id,
          label: tc("plan.option", { name: bundleName(p.bundle), price: money(p.priceMinor) }),
        }))}
    />
  );
  const domain = (
    <CertificatePanel
      requestAction={certRequestAction}
      refreshAction={certRefreshAction}
      removeAction={certRemoveAction}
      replaceAction={certReplaceAction}
      removeRequestId={ids?.certRemove ?? requestId}
      replaceRequestId={ids?.certReplace ?? requestId}
      idField="cdnId"
      resourceId={cdn.id}
      requestId={ids?.cert ?? requestId}
      refreshRequestId={ids?.certRefresh ?? requestId}
      certificate={cdn.certificate}
      allowed={cdn.state === "active"}
    />
  );
  const destroy = (
    <>
      <h3 className="mergecolor h4">{t("detail.destroy.title")}</h3>
      <DestroyPanel
        action={destroyAction}
        cdnId={cdn.id}
        requestId={requestId}
        resourceName={cdn.name}
        disabled={!live}
      />
      <p className="seccolor mt-3">{t("detail.overview.recreated")}</p>
    </>
  );

  return (
    <>
      <p className="mb-3">
        <a href={listHref}>
          <i className="fas fa-arrow-left me-1" aria-hidden="true" />
          {t("detail.back")}
        </a>
      </p>
      <Card className="mb-4">
        <h1 className="mergecolor h3 mb-2">{cdn.name === "" ? t("list.none") : cdn.name}</h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <CdnState state={cdn.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            {
              id: "overview",
              title: t("detail.tab.overview"),
              content:
                renewal === null ? (
                  overview
                ) : (
                  <>
                    {overview}
                    {renewal}
                  </>
                ),
            },
            { id: "settings", title: t("detail.tab.settings"), content: settings },
            { id: "cache", title: tc("tab.cache"), content: cache },
            { id: "origin", title: tc("tab.origin"), content: origin },
            { id: "plan", title: tc("tab.plan"), content: plan },
            { id: "domain", title: tc("tab.domain"), content: domain },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined &&
          ["settings", "cache", "origin", "plan", "domain", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
