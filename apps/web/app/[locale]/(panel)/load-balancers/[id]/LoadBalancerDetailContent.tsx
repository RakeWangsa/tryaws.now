import { Button, Card, DataTable, EmptyState, StatTile, Tabs, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { LoadBalancerDetail } from "../../../../../server/load-balancers-view.ts";
import { DestroyPanel } from "../../_family/FamilyForms.tsx";
import { FamilyState } from "../../_family/FamilyParts.tsx";
import { useRegionLabel } from "../../servers/ServerParts.tsx";
import { LoadBalancerTargetsForm } from "./LoadBalancerTargetsForm.tsx";

// The content of /load-balancers/[id] (16.10): a header and the tabs Overview, Target servers, Health
// and HTTPS, and Delete. A balancer of another customer and a missing one give the same answer (R8).
// Nothing here shows an account id, an ARN or a generated AWS name (R11). Health and the HTTPS
// certificate are shown as "not available yet": the web tier cannot read them (R1) and the backend has
// no certificate step.

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });

export function LoadBalancerDetailContent({
  locale,
  numerals,
  balancer,
  requestId,
  destroyAction = refuse,
  targetsAction,
  defaultTab,
}: {
  locale: Locale;
  numerals: Numerals;
  balancer: LoadBalancerDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  destroyAction?: Action;
  /** The Server Action of setTargets. Without it the tab says that changing targets is not available yet. */
  targetsAction?: Action;
  defaultTab?: string;
}) {
  const t = useTranslations("LoadBalancers");
  const regionLabel = useRegionLabel();
  const listHref = localePath(locale, "/load-balancers");

  if (balancer === null) {
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

  const none = t("list.none");
  const overview = (
    <div className="row g-3">
      <div className="col-12 col-md-6">
        <StatTile
          value={regionLabel(balancer.region)}
          description={t("detail.overview.location")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile value={String(balancer.targetCount)} description={t("detail.overview.targets")} />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(balancer.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
    </div>
  );

  const present = balancer.targets.filter((target) => target.state !== null);
  const targets = (
    <>
      <p className="seccolor">{t("detail.targets.intro")}</p>
      {balancer.targets.length === 0 ? (
        <EmptyState
          title={t("detail.targets.empty.title")}
          description={t("detail.targets.empty.body")}
        />
      ) : (
        <DataTable
          caption={t("detail.targets.caption")}
          rows={balancer.targets}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "name",
              header: t("detail.targets.name"),
              cell: (row) =>
                row.state === null
                  ? t("detail.targets.removed")
                  : row.name === ""
                    ? none
                    : row.name,
            },
            {
              key: "state",
              header: t("detail.targets.state"),
              cell: (row) =>
                row.state === null ? none : <FamilyState ns="LoadBalancers" state={row.state} />,
            },
          ]}
        />
      )}
      <div className="mt-4">
        {targetsAction === undefined ? (
          <p className="seccolor">{t("detail.targets.edit.unavailable")}</p>
        ) : (
          <LoadBalancerTargetsForm
            action={targetsAction}
            loadBalancerId={balancer.id}
            requestId={requestId}
            options={[
              ...present.map((target) => ({ id: target.id, name: target.name })),
              ...balancer.candidates,
            ]}
            current={present.map((target) => target.id)}
          />
        )}
      </div>
    </>
  );

  const health = (
    <>
      <h3 className="mergecolor h4">{t("detail.health.title")}</h3>
      <EmptyState
        title={t("detail.health.unavailable.title")}
        description={t("detail.health.unavailable.body")}
      />
      <h3 className="mergecolor h4 mt-4">{t("detail.health.https.title")}</h3>
      <p className="seccolor">{t("detail.health.https.body")}</p>
    </>
  );

  const live =
    balancer.state === "active" || balancer.state === "stopped" || balancer.state === "suspended";
  const destroy = (
    <>
      <h3 className="mergecolor h4">{t("detail.destroy.title")}</h3>
      <DestroyPanel
        ns="LoadBalancers"
        action={destroyAction}
        idField="loadBalancerId"
        resourceId={balancer.id}
        requestId={requestId}
        resourceName={balancer.name}
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
        <h1 className="mergecolor h3 mb-2">{balancer.name === "" ? none : balancer.name}</h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <FamilyState ns="LoadBalancers" state={balancer.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            { id: "overview", title: t("detail.tab.overview"), content: overview },
            { id: "targets", title: t("detail.tab.targets"), content: targets },
            { id: "health", title: t("detail.tab.health"), content: health },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined && ["targets", "health", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
