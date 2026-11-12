import { Button, DataTable, DateText, EmptyState, MoneyText, PriceBreakdown } from "@tc/ui";
import type { ReactNode } from "react";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type {
  BackupItem,
  DiskItem,
  InvoiceItem,
  MetricRangeKey,
  MetricsScreen,
  ServerExtras,
} from "../../../../../server/extras-view.ts";
import { METRIC_RANGE_KEYS } from "../../../../../server/extras-view.ts";
import { MetricChart } from "./MetricsCharts.tsx";
import {
  ActionNotice,
  AddDiskForm,
  AttachDiskForm,
  AutoBackupForm,
  AutoRenewForm,
  RenewNowForm,
  RestoreForm,
  CreateBackupForm,
  DestroyButton,
  PostButton,
  type ExtrasAction,
} from "./ExtrasForms.tsx";

// The tabs Backups, Storage, Metrics, Billing and Destroy of /servers/[id] (16.10). Synchronous, so
// they render in a test without a request. Nothing here shows an account id, an ARN, a generated AWS
// name or an error text of AWS (U6, R11).

type Numerals = "beng" | "latn";

export interface ExtrasActions {
  createBackup: ExtrasAction;
  deleteBackup: ExtrasAction;
  setAutoBackup: ExtrasAction;
  addDisk: ExtrasAction;
  attachDisk: ExtrasAction;
  detachDisk: ExtrasAction;
  destroyDisk: ExtrasAction;
  setAutoRenew: ExtrasAction;
  renewNow: ExtrasAction;
  restoreToNewServer: ExtrasAction;
  destroyServer: ExtrasAction;
}

export interface ExtrasBundle {
  data: ServerExtras;
  metrics: MetricsScreen;
  actions: ExtrasActions;
}

function BackupsTab({
  data,
  actions,
  numerals,
}: {
  data: ServerExtras;
  actions: ExtrasActions;
  numerals: Numerals;
}) {
  const t = useTranslations("Extras.backups");
  const te = useTranslations("Extras");
  const rows: BackupItem[] = data.backups;
  return (
    <>
      <p className="seccolor">{t("intro")}</p>
      {data.canBackup ? null : <p className="seccolor">{te("notLive")}</p>}
      {rows.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        <DataTable
          caption={t("caption")}
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "name",
              header: t("name"),
              cell: (row) => (row.name === "" ? te("none") : row.name),
            },
            {
              key: "kind",
              header: t("kind"),
              cell: (row) => (row.final ? t("final") : t("manual")),
            },
            {
              key: "size",
              header: t("size"),
              cell: (row) => (row.sizeGb === null ? te("none") : t("gb", { size: row.sizeGb })),
            },
            {
              key: "date",
              header: t("date"),
              cell: (row) => <DateText value={row.createdAt} numerals={numerals} />,
            },
            {
              key: "state",
              header: t("state"),
              cell: (row) => (te.has(`state.${row.state}`) ? te(`state.${row.state}`) : row.state),
            },
            {
              key: "actions",
              header: "",
              cell: (row) =>
                row.final || row.state !== "active" || row.name === "" ? null : (
                  <DestroyButton
                    action={actions.deleteBackup}
                    fields={{ backupId: row.id, requestId: data.requestId }}
                    resourceName={row.name}
                    label={t("delete")}
                    title={t("deleteTitle")}
                    description={t("deleteDescription")}
                    size="sm"
                  />
                ),
            },
          ]}
        />
      )}
      <div className="row g-4 mt-1">
        <div className="col-12 col-lg-6">
          <CreateBackupForm
            action={actions.createBackup}
            serverId={data.id}
            requestId={data.requestId}
            disabled={!data.canBackup}
          />
        </div>
        <div className="col-12 col-lg-6">
          <AutoBackupForm
            action={actions.setAutoBackup}
            serverId={data.id}
            requestId={data.requestId}
            enabled={data.autoBackup.enabled}
            hour={data.autoBackup.hour}
            disabled={!data.canBackup}
          />
        </div>
      </div>
      <div className="mt-4">
        <RestoreForm
          action={actions.restoreToNewServer}
          region={data.region ?? ""}
          backups={rows
            .filter((b) => b.state === "active")
            .map((b) => ({ id: b.id, name: b.name !== "" ? b.name : t("final") }))}
          plans={data.restorePlans}
          disabled={!data.canBackup || data.region === null}
        />
      </div>
    </>
  );
}

// WPU-G19: the commands that make an attached disk usable. They are shell text, not words, so they
// are not translated; the steps around them are.
const MOUNT_STEPS = [
  { key: "find", command: "lsblk" },
  { key: "format", command: "sudo mkfs.ext4 /dev/xvdf" },
  { key: "mount", command: "sudo mkdir -p /data && sudo mount /dev/xvdf /data" },
  { key: "persist", command: "sudo blkid /dev/xvdf" },
] as const;

function MountHelp() {
  const t = useTranslations("Extras.storage.mount");
  return (
    <div className="mt-4">
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <ol className="seccolor">
        {MOUNT_STEPS.map((step) => (
          <li key={step.key} className="mb-2">
            {t(step.key)} <code>{step.command}</code>
          </li>
        ))}
      </ol>
      <p className="seccolor">{t("note")}</p>
    </div>
  );
}

function StorageTab({ data, actions }: { data: ServerExtras; actions: ExtrasActions }) {
  const t = useTranslations("Extras.storage");
  const te = useTranslations("Extras");
  const size = (disk: DiskItem): ReactNode =>
    disk.sizeGb === null ? te("none") : `${disk.sizeGb} GB`;
  return (
    <>
      <p className="seccolor">{t("intro")}</p>
      {data.disks.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        <DataTable
          caption={t("caption")}
          rows={data.disks}
          rowKey={(row) => row.id}
          columns={[
            { key: "name", header: t("name"), cell: (row) => row.name || te("none") },
            { key: "size", header: t("size"), cell: size },
            { key: "state", header: t("state"), cell: () => t("attachedHere") },
            {
              key: "actions",
              header: "",
              cell: (row) => (
                <PostButton
                  action={actions.detachDisk}
                  fields={{ diskId: row.id, requestId: data.requestId }}
                  label={t("detach")}
                  icon="fas fa-unlink"
                />
              ),
            },
          ]}
        />
      )}
      {data.disks.length === 0 ? null : <MountHelp />}
      {data.freeDisks.length === 0 ? null : (
        <>
          <h3 className="mergecolor h4 mt-4">{t("freeCaption")}</h3>
          <DataTable
            caption={t("freeCaption")}
            rows={data.freeDisks}
            rowKey={(row) => row.id}
            columns={[
              { key: "name", header: t("name"), cell: (row) => row.name || te("none") },
              { key: "size", header: t("size"), cell: size },
              {
                key: "actions",
                header: "",
                cell: (row) => (
                  <DestroyButton
                    action={actions.destroyDisk}
                    fields={{ diskId: row.id, requestId: data.requestId }}
                    resourceName={row.name}
                    label={t("destroy")}
                    title={t("destroyTitle")}
                    description={t("destroyDescription")}
                    size="sm"
                  />
                ),
              },
            ]}
          />
        </>
      )}
      <div className="mt-4">
        <AttachDiskForm
          action={actions.attachDisk}
          serverId={data.id}
          requestId={data.requestId}
          disks={data.freeDisks.map((d) => ({ id: d.id, name: d.name || d.id.slice(0, 8) }))}
        />
      </div>
      <div className="mt-4">
        <AddDiskForm
          action={actions.addDisk}
          serverId={data.id}
          region={data.region}
          offer={data.diskOffer}
        />
      </div>
    </>
  );
}

function MetricsTab({
  serverId,
  metrics,
  locale,
  numerals,
}: {
  serverId: string;
  metrics: MetricsScreen;
  locale: Locale;
  numerals: Numerals;
}) {
  const t = useTranslations("Extras.metrics");
  const range: MetricRangeKey = metrics.state === "unavailable" ? "1h" : metrics.range;
  const href = (key: MetricRangeKey) =>
    `${localePath(locale, `/servers/${encodeURIComponent(serverId)}`)}?tab=metrics&range=${key}`;
  return (
    <>
      <nav className="d-flex flex-wrap gap-2 mb-3" aria-label={t("rangeLabel")}>
        {METRIC_RANGE_KEYS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={key === range ? "primary" : "default"}
            href={href(key)}
          >
            {t(`range.${key}`)}
          </Button>
        ))}
      </nav>
      {metrics.state === "unavailable" ? (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      ) : metrics.state === "empty" ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        metrics.series.map((series) => (
          <MetricChart
            key={series.metric}
            series={series}
            name={t(series.metric)}
            locale={locale}
            numerals={numerals}
            range={metrics.range}
          />
        ))
      )}
    </>
  );
}

function BillingTab({
  data,
  actions,
  numerals,
}: {
  data: ServerExtras;
  actions: ExtrasActions;
  numerals: Numerals;
}) {
  const t = useTranslations("Extras.billing");
  const stepLabel = useTranslations("Orders.review.step");
  const { billing } = data;
  if (billing.status === null) return <p className="seccolor">{t("noSubscription")}</p>;
  return (
    <>
      {billing.renewalWait === null ? null : (
        <p className="seccolor mb-3" role="status">
          {t(`renewalWait.${billing.renewalWait}`)}
        </p>
      )}
      <div className="row g-3 mb-3">
        <div className="col-12 col-md-6">
          <p className="seccolor mb-1">{t("status")}</p>
          <b className="mergecolor">{t(`statusValue.${billing.status}`)}</b>
        </div>
        {billing.periodStart === null || billing.periodEnd === null ? null : (
          <>
            <div className="col-12 col-md-6">
              <p className="seccolor mb-1">{t("period")}</p>
              <b className="mergecolor">
                <DateText value={billing.periodStart} numerals={numerals} />
                {" – "}
                <DateText value={billing.periodEnd} numerals={numerals} />
              </b>
            </div>
            <div className="col-12 col-md-6">
              <p className="seccolor mb-1">{t("next")}</p>
              <b className="mergecolor">
                <DateText value={billing.periodEnd} numerals={numerals} />
              </b>
            </div>
          </>
        )}
      </div>
      {billing.lines === null ? null : (
        <>
          <h3 className="mergecolor h4">{t("linesTitle")}</h3>
          <PriceBreakdown
            baseMinor={billing.lines.baseMinor}
            totalMinor={billing.lines.totalMinor}
            steps={billing.lines.steps.map((step) => ({
              code: step.code,
              label: stepLabel.has(step.code) ? stepLabel(step.code) : step.code,
              amountMinor: step.amountMinor,
            }))}
          />
        </>
      )}
      <AutoRenewForm
        action={actions.setAutoRenew}
        serverId={data.id}
        autoRenew={billing.autoRenew}
      />
      <h3 className="mergecolor h4 mt-4">{t("invoices.title")}</h3>
      {billing.invoices.length === 0 ? (
        <p className="seccolor">{t("invoices.empty")}</p>
      ) : (
        <DataTable
          caption={t("invoices.caption")}
          rows={billing.invoices as InvoiceItem[]}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "number",
              header: t("invoices.number"),
              cell: (row) => `${row.fiscalYear}-${row.number}`,
            },
            {
              key: "date",
              header: t("invoices.date"),
              cell: (row) => <DateText value={row.issuedAt} numerals={numerals} />,
            },
            {
              key: "total",
              header: t("invoices.total"),
              cell: (row) => <MoneyText minor={row.totalMinor} mode="exact" numerals={numerals} />,
            },
          ]}
        />
      )}
      <RenewNowForm
        action={actions.renewNow}
        serverId={data.id}
        disabled={billing.status !== "active" && billing.status !== "grace"}
      />
    </>
  );
}

function DestroyTab({ data, actions }: { data: ServerExtras; actions: ExtrasActions }) {
  const t = useTranslations("Extras.destroy");
  return (
    <>
      <h3 className="mergecolor h4">{t("deletes")}</h3>
      <div className="alert alert-warning text-start" role="note">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("deletesBody")}
      </div>
      <h3 className="mergecolor h4">{t("keeps")}</h3>
      <p className="seccolor">{t("keepsBody", { count: data.destroy.manualBackups })}</p>
      <h3 className="mergecolor h4">{t("period")}</h3>
      <p className="seccolor">{t("periodBody")}</p>
      {data.name === "" ? <p className="seccolor">{t("noName")}</p> : null}
      {data.destroy.allowed ? null : <p className="seccolor">{t("notAllowed")}</p>}
      <DestroyButton
        action={actions.destroyServer}
        fields={{ serverId: data.id, requestId: data.requestId }}
        resourceName={data.name}
        label={t("button")}
        title={t("confirmTitle")}
        description={t("confirmDescription")}
        disabled={!data.destroy.allowed}
      />
    </>
  );
}

/** The five tabs, ready for `Tabs`. */
export function useExtraTabs(
  bundle: ExtrasBundle | null,
  locale: Locale,
  numerals: Numerals,
): { id: string; title: ReactNode; content: ReactNode }[] {
  const t = useTranslations("Extras.tab");
  if (bundle === null) return [];
  const { data, metrics, actions } = bundle;
  return [
    {
      id: "backups",
      title: t("backups"),
      content: <BackupsTab data={data} actions={actions} numerals={numerals} />,
    },
    { id: "storage", title: t("storage"), content: <StorageTab data={data} actions={actions} /> },
    {
      id: "metrics",
      title: t("metrics"),
      content: (
        <MetricsTab serverId={data.id} metrics={metrics} locale={locale} numerals={numerals} />
      ),
    },
    {
      id: "billing",
      title: t("billing"),
      content: <BillingTab data={data} actions={actions} numerals={numerals} />,
    },
    { id: "destroy", title: t("destroy"), content: <DestroyTab data={data} actions={actions} /> },
  ];
}

export { ActionNotice };
