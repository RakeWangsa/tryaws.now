import type { ReactNode } from "react";
import {
  Button,
  Card,
  CopyField,
  DataTable,
  DateText,
  EmptyState,
  StatTile,
  Tabs,
  formatDate,
} from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DatabaseDetail } from "../../../../../server/databases-view.ts";
import { DestroyPanel, RunningForm } from "../../_family/FamilyForms.tsx";
import { FamilyState } from "../../_family/FamilyParts.tsx";
import { useRegionLabel } from "../../servers/ServerParts.tsx";
import { useEngineLabel } from "../DatabaseParts.tsx";
import { DatabaseAccess } from "./DatabaseAccess.tsx";
import { DatabaseBackups } from "./DatabaseBackups.tsx";
import type { SnapshotAction } from "./DatabaseBackups.tsx";
import type { DatabaseRevealResult } from "./DatabaseAccess.tsx";

// The content of /databases/[id] (16.10): a header and the tabs Overview, Connect, Backups, Metrics,
// Settings and Delete. A database of another customer and a missing one give the same answer (R8). The
// endpoint and the port are shown because the customer needs them (U6); nothing here shows an account
// id, an ARN or a generated AWS name (R11). The password is not part of this markup (U9).

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;
type RevealAction = (form: FormData) => Promise<DatabaseRevealResult>;

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });
const refuseReveal: RevealAction = async () => ({ ok: false, error: "unavailable" });

export function DatabaseDetailContent({
  locale,
  numerals,
  database,
  requestId,
  runningAction = refuse,
  destroyAction = refuse,
  revealAction = refuseReveal,
  defaultTab,
  initialSecret = null,
  extra = null,
  snapshots,
}: {
  locale: Locale;
  numerals: Numerals;
  database: DatabaseDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  runningAction?: Action;
  destroyAction?: Action;
  revealAction?: RevealAction;
  defaultTab?: string;
  /** The console form of the settings tab (WPU-G7), built by the page. */
  extra?: ReactNode;
  /**
   * WPU-G9. The actions of the Backups tab; without them (the static mockup states) the tab shows the
   * read-only table.
   */
  snapshots?: {
    requestIds: { create: string; delete: string };
    create: SnapshotAction;
    delete: SnapshotAction;
    restore: SnapshotAction;
    pitr: SnapshotAction;
  };
  /** Tests only: the Connect tab as it is after the button. */
  initialSecret?: { username: string; password: string } | null;
}) {
  const t = useTranslations("Databases");
  const tc = useTranslations("DbConnect");
  const regionLabel = useRegionLabel();
  const engineLabel = useEngineLabel();
  const listHref = localePath(locale, "/databases");

  if (database === null) {
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
          value={engineLabel(database.specs) ?? none}
          description={t("detail.overview.engine")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={regionLabel(database.region)}
          description={t("detail.overview.location")}
        />
      </div>
      <div className="col-12 col-md-6">
        {database.endpoint === null ? (
          <StatTile value={none} description={t("detail.overview.endpointPending")} />
        ) : (
          <CopyField
            label={t("detail.overview.endpoint")}
            value={database.endpoint}
            hint={t("detail.overview.endpointHint")}
          />
        )}
      </div>
      <div className="col-12 col-md-6">
        {database.port === null ? (
          <StatTile value={none} description={t("detail.overview.portPending")} />
        ) : (
          <CopyField label={t("detail.overview.port")} value={String(database.port)} />
        )}
      </div>
      <div className="col-12 col-md-6">
        {database.masterUsername === null ? (
          <StatTile value={none} description={tc("username")} />
        ) : (
          <CopyField label={tc("username")} value={database.masterUsername} />
        )}
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={database.console?.maintenanceWindow ?? tc("maintenanceUnknown")}
          description={tc("maintenance")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={tc("retention", { days: database.retentionDays })}
          description={tc("retentionNote")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={t("detail.overview.accessValue")}
          description={t("detail.overview.access")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(database.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
    </div>
  );

  const access = (
    <DatabaseAccess
      resourceId={database.id}
      running={database.state === "active"}
      action={revealAction}
      initial={initialSecret}
    />
  );

  const stateWord = (state: string): string =>
    state === "active"
      ? t("detail.backups.stateActive")
      : state === "creating"
        ? t("detail.backups.stateCreating")
        : t("detail.backups.stateOther");
  const backups =
    snapshots !== undefined ? (
      <DatabaseBackups
        database={database}
        numerals={numerals}
        requestIds={snapshots.requestIds}
        createAction={snapshots.create}
        deleteAction={snapshots.delete}
        restoreAction={snapshots.restore}
        pitrAction={snapshots.pitr}
      />
    ) : (
      <>
        <p className="seccolor">{t("detail.backups.intro")}</p>
        {database.backups.length === 0 ? (
          <EmptyState
            title={t("detail.backups.empty.title")}
            description={t("detail.backups.empty.body")}
          />
        ) : (
          <DataTable
            caption={t("detail.backups.caption")}
            rows={database.backups}
            rowKey={(row) => row.id}
            columns={[
              { key: "name", header: t("detail.backups.name"), cell: (row) => row.name || none },
              {
                key: "kind",
                header: t("detail.backups.kind"),
                cell: (row) => (row.final ? t("detail.backups.final") : t("detail.backups.manual")),
              },
              {
                key: "size",
                header: t("detail.backups.size"),
                cell: (row) =>
                  row.sizeGb === null ? none : t("detail.backups.gb", { size: row.sizeGb }),
              },
              {
                key: "date",
                header: t("detail.backups.date"),
                cell: (row) => <DateText value={row.createdAt} numerals={numerals} />,
              },
              {
                key: "state",
                header: t("detail.backups.state"),
                cell: (row) => stateWord(row.state),
              },
            ]}
          />
        )}
        <p className="seccolor mt-3">{t("detail.backups.createUnavailable")}</p>
        <p className="seccolor">{t("detail.backups.restoreSoon")}</p>
      </>
    );

  const metrics = (
    <EmptyState
      title={t("detail.metrics.unavailable.title")}
      description={t("detail.metrics.unavailable.body")}
    />
  );

  // Stop from active, start from stopped; every other state belongs to the lifecycle (R13).
  const switchable = database.state === "active" || database.state === "stopped";
  const settings = (
    <>
      <h3 className="mergecolor h4">{t("detail.switch.title")}</h3>
      <RunningForm
        ns="Databases"
        action={runningAction}
        idField="databaseId"
        resourceId={database.id}
        requestId={requestId}
        running={database.state !== "stopped"}
        allowed={switchable}
      />
      {extra === null ? null : <div className="mt-4">{extra}</div>}
    </>
  );

  const live =
    database.state === "active" || database.state === "stopped" || database.state === "suspended";
  const destroy = (
    <>
      <h3 className="mergecolor h4">{t("detail.destroy.title")}</h3>
      <DestroyPanel
        ns="Databases"
        action={destroyAction}
        idField="databaseId"
        resourceId={database.id}
        requestId={requestId}
        resourceName={database.name}
        disabled={!live}
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
        <h1 className="mergecolor h3 mb-2">{database.name === "" ? none : database.name}</h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <FamilyState ns="Databases" state={database.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            { id: "overview", title: t("detail.tab.overview"), content: overview },
            { id: "access", title: t("detail.tab.access"), content: access },
            { id: "backups", title: t("detail.tab.backups"), content: backups },
            { id: "metrics", title: t("detail.tab.metrics"), content: metrics },
            { id: "settings", title: t("detail.tab.settings"), content: settings },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined &&
          ["access", "backups", "metrics", "settings", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
