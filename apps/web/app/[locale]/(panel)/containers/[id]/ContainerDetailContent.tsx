import {
  Button,
  Card,
  CopyField,
  DataTable,
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
import type { DeploymentHistoryFacts } from "../../../../../server/console-view.ts";
import type { ContainerDetail, DeploymentRun } from "../../../../../server/container-view.ts";
import { ContainerState, useRegionLabel } from "../ContainerParts.tsx";
import {
  CertificatePanel,
  EndpointForm,
  PlanChangeForm,
} from "../../_console/PlanAndCertForms.tsx";
import { DeployForm, DestroyPanel } from "./ContainerForms.tsx";

// The content of /containers/[id] (16.10): a header and the tabs Overview, Deployments, New
// deployment and Delete. A service of another customer and a missing one give the same answer (R8).
// The public address is shown because the customer needs it (U6); nothing here shows an account id,
// an ARN or a generated AWS name (R11). The values of environment variables are never shown (R14).
// What the web tier cannot read (usage, the address before the image runs) says so (16.13).

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** One request id for each form of the page (R7): two forms never share an idempotency key. */
export interface FormIds {
  plan: string;
  planCancel: string;
  cert: string;
  certRefresh: string;
  endpoint: string;
  endpointRemove: string;
}

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });

export function ContainerDetailContent({
  locale,
  numerals,
  service,
  requestId,
  deployAction = refuse,
  destroyAction = refuse,
  planAction = refuse,
  certRequestAction = refuse,
  certRefreshAction = refuse,
  endpointAction = refuse,
  ids,
  defaultTab,
}: {
  locale: Locale;
  numerals: Numerals;
  service: ContainerDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  deployAction?: Action;
  destroyAction?: Action;
  /** WPU-G8: plan at the next renewal, custom domain and certificate, public endpoint. */
  planAction?: Action;
  certRequestAction?: Action;
  certRefreshAction?: Action;
  endpointAction?: Action;
  ids?: FormIds;
  defaultTab?: string;
}) {
  const t = useTranslations("Containers");
  const tc = useTranslations("Console");
  const regionLabel = useRegionLabel();
  const listHref = localePath(locale, "/containers");

  if (service === null) {
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
          value={
            service.power === null ? t("detail.overview.planUnknown") : t(`power.${service.power}`)
          }
          description={t("detail.overview.power")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={service.scale === null ? t("detail.overview.planUnknown") : String(service.scale)}
          description={t("detail.overview.scale")}
        />
      </div>
      <div className="col-12">
        {service.publicUrl === null ? (
          <StatTile value={t("list.none")} description={t("detail.overview.urlPending")} />
        ) : (
          <CopyField
            label={t("detail.overview.url")}
            value={service.publicUrl}
            hint={t("detail.overview.urlHint")}
          />
        )}
      </div>
      <div className="col-12 col-md-6">
        <StatTile value={regionLabel(service.region)} description={t("detail.overview.location")} />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(service.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
      <div className="col-12">
        <StatTile
          value={t("list.none")}
          description={`${t("detail.overview.metrics")}: ${t("detail.overview.metricsUnavailable")}`}
        />
      </div>
      <div className="col-12">
        <p className="seccolor">{t("detail.overview.scaleNote")}</p>
      </div>
    </div>
  );

  const runColumns = [
    {
      key: "date",
      header: t("detail.deployments.date"),
      cell: (row: DeploymentRun) => formatDate(row.createdAt, { locale, numerals }),
    },
    {
      key: "state",
      header: t("detail.deployments.state"),
      cell: (row: DeploymentRun) => (
        <>
          {t.has(`opState.${row.state}`) ? t(`opState.${row.state}`) : t("opState.queued")}
          {row.needsApproval && row.state !== "needs_approval"
            ? ` (${t("opState.needs_approval")})`
            : ""}
        </>
      ),
    },
  ];
  const current = service.deployment;
  const deployments = (
    <>
      <h3 className="mergecolor h4">{t("detail.deployments.title")}</h3>
      {current === null || current.containers.length === 0 ? (
        <p className="seccolor">{t("detail.deployments.none")}</p>
      ) : (
        <>
          {current.containers.map((container, index) => (
            <div key={index} className="row g-3 mb-3">
              <div className="col-12">
                <StatTile value={container.image} description={t("detail.deployments.image")} />
              </div>
              <div className="col-12 col-md-6">
                <StatTile
                  value={
                    container.ports.length === 0
                      ? t("detail.deployments.portsNone")
                      : container.ports.map((p) => `${p.port}/${p.protocol}`).join(", ")
                  }
                  description={t("detail.deployments.ports")}
                />
              </div>
              <div className="col-12 col-md-6">
                <StatTile
                  value={
                    container.variables.length === 0
                      ? t("detail.deployments.variablesNone")
                      : container.variables.join(", ")
                  }
                  description={`${t("detail.deployments.variables")}. ${t("detail.deployments.variablesNote")}`}
                />
              </div>
            </div>
          ))}
          <div className="row g-3 mb-3">
            <div className="col-12 col-md-6">
              <StatTile
                value={
                  current.publicEndpoint === null
                    ? t("detail.deployments.endpointNone")
                    : t("detail.deployments.endpointPort", { port: current.publicEndpoint.port })
                }
                description={t("detail.deployments.endpoint")}
              />
            </div>
            {current.publicEndpoint?.healthCheckPath ? (
              <div className="col-12 col-md-6">
                <StatTile
                  value={current.publicEndpoint.healthCheckPath}
                  description={t("detail.deployments.health")}
                />
              </div>
            ) : null}
          </div>
        </>
      )}
      <h3 className="mergecolor h4">{tc("history.title")}</h3>
      {service.history.length === 0 ? (
        <p className="seccolor">{tc("history.none")}</p>
      ) : (
        <DataTable
          caption={tc("history.caption")}
          columns={[
            {
              key: "date",
              header: tc("history.date"),
              cell: (row: DeploymentHistoryFacts) => formatDate(row.at, { locale, numerals }),
            },
            {
              key: "images",
              header: tc("history.images"),
              cell: (row: DeploymentHistoryFacts) => row.images.join(", "),
            },
            {
              key: "endpoint",
              header: tc("history.endpoint"),
              cell: (row: DeploymentHistoryFacts) =>
                row.endpoint ? tc("history.yes") : tc("history.no"),
            },
          ]}
          rows={service.history}
          rowKey={(row) => row.at.toISOString()}
        />
      )}
      <p className="seccolor mt-2">{tc("history.logs")}</p>
      <h3 className="mergecolor h4 mt-4">{t("detail.deployments.historyTitle")}</h3>
      {service.runs.length === 0 ? (
        <p className="seccolor">{t("detail.deployments.historyNone")}</p>
      ) : (
        <DataTable
          caption={t("detail.deployments.historyCaption")}
          columns={runColumns}
          rows={service.runs}
          rowKey={(row) => row.id}
        />
      )}
    </>
  );

  const deploy = (
    <>
      <h3 className="mergecolor h4">{t("detail.deploy.title")}</h3>
      <DeployForm
        action={deployAction}
        containerId={service.id}
        requestId={requestId}
        allowed={service.state === "active"}
      />
    </>
  );

  const ep = service.deployment?.publicEndpoint ?? null;
  const endpoint = (
    <EndpointForm
      action={endpointAction}
      containerId={service.id}
      requestId={ids?.endpoint ?? requestId}
      removeRequestId={ids?.endpointRemove ?? requestId}
      current={{
        container: service.endpointContainer,
        port: ep?.port ?? null,
        healthCheckPath: ep?.healthCheckPath ?? null,
      }}
      hasDeployment={service.deployment !== null}
      allowed={service.state === "active"}
    />
  );

  const planName = (id: string): string | null => {
    const found = service.plans?.find((p) => p.id === id);
    return found === undefined
      ? null
      : `${t(`power.${found.power}`)} · ${t("plan.scale", { count: found.scale })}`;
  };
  const priceOf = (id: string): string | null => {
    const found = service.plans?.find((p) => p.id === id);
    return found === undefined ? null : formatMoney(found.priceMinor, { locale, numerals });
  };
  const pendingName = service.pendingProductId === null ? null : planName(service.pendingProductId);
  const planTab = (
    <PlanChangeForm
      action={planAction}
      idField="containerId"
      resourceId={service.id}
      requestId={ids?.plan ?? requestId}
      cancelRequestId={ids?.planCancel ?? requestId}
      kind="container"
      currentName={
        service.currentProductId === null
          ? service.power === null
            ? null
            : `${t(`power.${service.power}`)} · ${t("plan.scale", { count: service.scale ?? 1 })}`
          : (planName(service.currentProductId) ??
            (service.power === null
              ? null
              : `${t(`power.${service.power}`)} · ${t("plan.scale", { count: service.scale ?? 1 })}`))
      }
      renewsText={
        service.renewsAt === null
          ? null
          : tc("plan.renews", { date: formatDate(service.renewsAt, { locale, numerals }) })
      }
      pendingText={
        service.pendingProductId === null
          ? null
          : pendingName === null
            ? tc("plan.pendingGone")
            : tc("plan.pending", {
                name: pendingName,
                price: priceOf(service.pendingProductId) ?? "",
              })
      }
      hasPending={service.pendingProductId !== null}
      state={
        service.state !== "active" && service.state !== "stopped" && service.state !== "suspended"
          ? "inactive"
          : service.plans === null
            ? "unpriced"
            : "ready"
      }
      choices={(service.plans ?? [])
        .filter((p) => p.id !== service.currentProductId)
        .map((p) => ({
          id: p.id,
          label: tc("plan.option", {
            name: `${t(`power.${p.power}`)} · ${t("plan.scale", { count: p.scale })}`,
            price: formatMoney(p.priceMinor, { locale, numerals }),
          }),
        }))}
    />
  );

  const domainTab = (
    <CertificatePanel
      requestAction={certRequestAction}
      refreshAction={certRefreshAction}
      idField="containerId"
      resourceId={service.id}
      requestId={ids?.cert ?? requestId}
      refreshRequestId={ids?.certRefresh ?? requestId}
      certificate={service.certificate}
      allowed={service.state === "active"}
    />
  );

  const live =
    service.state === "active" || service.state === "stopped" || service.state === "suspended";
  const destroy = (
    <>
      <h3 className="mergecolor h4">{t("detail.destroy.title")}</h3>
      <DestroyPanel
        action={destroyAction}
        containerId={service.id}
        requestId={requestId}
        resourceName={service.name}
        disabled={!live || !service.destroyOpen}
      />
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
        <h1 className="mergecolor h3 mb-2">
          {service.name === "" ? t("list.none") : service.name}
        </h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <ContainerState state={service.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            { id: "overview", title: t("detail.tab.overview"), content: overview },
            { id: "deployments", title: t("detail.tab.deployments"), content: deployments },
            { id: "deploy", title: t("detail.tab.deploy"), content: deploy },
            { id: "endpoint", title: tc("tab.endpoint"), content: endpoint },
            { id: "plan", title: tc("tab.plan"), content: planTab },
            { id: "domain", title: tc("tab.domain"), content: domainTab },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined &&
          ["deployments", "deploy", "endpoint", "plan", "domain", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
