import { Button, Card, CopyField, EmptyState, StatTile, Tabs, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { CdnDetail } from "../../../../../server/cdn-view.ts";
import { CdnState, useOriginLabel } from "../CdnParts.tsx";
import { DestroyPanel, EnabledForm } from "./CdnForms.tsx";

// The content of /cdn/[id] (16.10): a header and the tabs Overview, Settings and Delete. A
// distribution of another customer and a missing one give the same answer (R8). The default domain
// is shown because the customer needs it (U6); nothing here shows an account id, an ARN or a
// generated AWS name (R11).

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });

export function CdnDetailContent({
  locale,
  numerals,
  cdn,
  requestId,
  enabledAction = refuse,
  destroyAction = refuse,
  defaultTab,
}: {
  locale: Locale;
  numerals: Numerals;
  cdn: CdnDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  enabledAction?: Action;
  destroyAction?: Action;
  defaultTab?: string;
}) {
  const t = useTranslations("Cdn");
  const originLabel = useOriginLabel();
  const listHref = localePath(locale, "/cdn");

  if (cdn === null) {
    return (
      <EmptyState
        title={t("detail.notFound.title")}
        description={t("detail.notFound.body")}
        action={
          <Button variant="primary" href={listHref}>
            {t("detail.back")}
          </Button>
        }
      />
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
    </>
  );

  const live = cdn.state === "active" || cdn.state === "stopped" || cdn.state === "suspended";
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
            { id: "overview", title: t("detail.tab.overview"), content: overview },
            { id: "settings", title: t("detail.tab.settings"), content: settings },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined && ["settings", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
