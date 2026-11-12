import {
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  MoneyText,
  StatTile,
  formatMoney,
} from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { DashboardView } from "../../../../server/extras-view.ts";

// The content of /dashboard (16.10): wallet balance, active resources per family, renewals in the
// next 7 days with amounts, alerts (KYC pending, low balance, resources in grace) and the last five
// operations. With nothing yet it is the checklist (verify phone, complete KYC, top up, create the
// first server). Server Component; nothing here shows an account id, an ARN or an AWS error (U6).

type Numerals = "beng" | "latn";

const KNOWN_FAMILIES = [
  "linux_instance",
  "windows_instance",
  "disk",
  "backup",
  "database",
  "bucket",
  "load_balancer",
  "container_service",
  "cdn",
  "dns",
  "domain",
];
const KNOWN_KINDS = [
  "create",
  "reboot",
  "stop",
  "start",
  "rename",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
  "create_backup",
  "delete_backup",
  "set_auto_backup",
  "attach_disk",
  "detach_disk",
  "destroy",
  "final_snapshot",
  "suspend",
  "resume",
];
const KNOWN_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "needs_approval",
  "needs_attention",
];
const pick = (list: readonly string[], value: string): string =>
  list.includes(value) ? value : "other";

export function DashboardContent({
  locale,
  numerals,
  view,
  flagOff,
}: {
  locale: Locale;
  numerals: Numerals;
  view: DashboardView;
  flagOff: boolean;
}) {
  const t = useTranslations("Dashboard");
  const walletHref = localePath(locale, "/wallet/topup");

  if (flagOff) {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }

  const empty = view.families.length === 0 && view.operations.length === 0;
  const alerts: {
    key: string;
    tone: "warning" | "danger";
    text: string;
    href?: string;
    cta?: string;
  }[] = [];
  if (view.alerts.kycPending) {
    alerts.push({
      key: "kyc",
      tone: "warning",
      text: t("alerts.kyc"),
      href: localePath(locale, "/settings/kyc"),
      cta: t("alerts.kycAction"),
    });
  }
  if (view.alerts.lowBalance) {
    alerts.push({
      key: "low",
      tone: "danger",
      text: t("alerts.lowBalance"),
      href: walletHref,
      cta: t("topUp"),
    });
  }
  for (const g of view.alerts.inGrace) {
    alerts.push({
      key: `grace-${g.resourceId}`,
      tone: "warning",
      text: g.name === "" ? t("alerts.graceNoName") : t("alerts.grace", { name: g.name }),
      href: localePath(locale, `/servers/${encodeURIComponent(g.resourceId)}`),
    });
  }

  const guide = view.onboarding;
  const hrefOf: Record<string, string> = {
    phone: localePath(locale, "/settings/profile"),
    kyc: localePath(locale, "/settings/kyc"),
    topUp: walletHref,
    sshKey: localePath(locale, "/settings/ssh-keys"),
    server: localePath(locale, "/servers/new"),
    firewall:
      view.guideServerId === null
        ? localePath(locale, "/servers")
        : `${localePath(locale, `/servers/${encodeURIComponent(view.guideServerId)}`)}?tab=networking`,
    snapshot: localePath(locale, "/snapshots"),
  };
  const doneCount = guide.steps.filter((step) => step.done).length;

  return (
    <>
      <h1 className="mergecolor h3 mb-4">{t("heading")}</h1>
      <div className="row g-3 mb-4">
        <div className="col-12 col-md-6">
          <StatTile
            value={formatMoney(view.balanceMinor, { locale, mode: "exact", numerals })}
            description={t("balance")}
          />
        </div>
        <div className="col-12 col-md-6 d-flex align-items-center">
          <Button variant="primary" href={walletHref}>
            {t("topUp")}
          </Button>
          <Button variant="default" href={localePath(locale, "/billing")} className="ms-2">
            {t("billing")}
          </Button>
        </div>
      </div>

      {!guide.complete ? (
        <Card className="mb-4">
          <h2 className="mergecolor h4">
            {guide.started ? t("checklist.titleNext") : t("checklist.title")}
          </h2>
          <p className="seccolor">
            {empty ? t("checklist.intro") : t("checklist.introNext")}{" "}
            {t("checklist.progress", { done: doneCount, total: guide.steps.length })}
          </p>
          <ol className="list-unstyled mb-0">
            {guide.steps.map((step) => (
              <li key={step.key} className="mb-3">
                <i
                  className={
                    step.done
                      ? "fas fa-check-circle me-2"
                      : step.locked
                        ? "fas fa-lock me-2"
                        : "far fa-circle me-2"
                  }
                  aria-hidden="true"
                />
                {step.locked ? (
                  <span className="seccolor">{t(`checklist.${step.key}`)}</span>
                ) : (
                  <a href={hrefOf[step.key]}>{t(`checklist.${step.key}`)}</a>
                )}
                {" · "}
                <span className="seccolor">
                  {step.done
                    ? t("checklist.done")
                    : step.locked
                      ? t("checklist.locked")
                      : step.key === guide.next
                        ? t("checklist.next")
                        : t("checklist.todo")}
                </span>
                {step.done ? null : (
                  <p className="seccolor mb-0 ms-4">{t(`checklist.hint.${step.key}`)}</p>
                )}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <Card className="mb-4">
        <h2 className="mergecolor h4">{t("alerts.title")}</h2>
        {alerts.length === 0 ? (
          <p className="seccolor mb-0">{t("alerts.none")}</p>
        ) : (
          alerts.map((alert) => (
            <div key={alert.key} className={`alert alert-${alert.tone} text-start`} role="alert">
              <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
              {alert.text}
              {alert.href !== undefined && alert.cta !== undefined ? (
                <>
                  {" "}
                  <a href={alert.href}>{alert.cta}</a>
                </>
              ) : null}
            </div>
          ))
        )}
      </Card>

      <Card className="mb-4">
        <h2 className="mergecolor h4">{t("families.title")}</h2>
        {view.families.length === 0 ? (
          <p className="seccolor mb-0">{t("families.empty")}</p>
        ) : (
          <DataTable
            caption={t("families.caption")}
            rows={view.families}
            rowKey={(row) => row.family}
            columns={[
              {
                key: "product",
                header: t("families.product"),
                cell: (row) => t(`families.name.${pick(KNOWN_FAMILIES, row.family)}`),
              },
              { key: "count", header: t("families.count"), cell: (row) => String(row.count) },
            ]}
          />
        )}
      </Card>

      <Card className="mb-4">
        <h2 className="mergecolor h4">{t("renewals.title")}</h2>
        {view.renewals.length === 0 ? (
          <p className="seccolor mb-0">{t("renewals.empty")}</p>
        ) : (
          <DataTable
            caption={t("renewals.caption")}
            rows={view.renewals}
            rowKey={(row) => row.resourceId}
            columns={[
              { key: "name", header: t("renewals.name"), cell: (row) => row.name || "—" },
              {
                key: "date",
                header: t("renewals.date"),
                cell: (row) => <DateText value={row.periodEnd} numerals={numerals} />,
              },
              {
                key: "amount",
                header: t("renewals.amount"),
                cell: (row) =>
                  row.amountMinor === null ? (
                    "—"
                  ) : (
                    <MoneyText minor={row.amountMinor} mode="exact" numerals={numerals} />
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card>
        <h2 className="mergecolor h4">{t("operations.title")}</h2>
        {view.operations.length === 0 ? (
          <p className="seccolor mb-0">{t("operations.empty")}</p>
        ) : (
          <DataTable
            caption={t("operations.caption")}
            rows={view.operations}
            rowKey={(row) => row.id}
            columns={[
              {
                key: "kind",
                header: t("operations.kind"),
                cell: (row) => t(`operations.kinds.${pick(KNOWN_KINDS, row.kind)}`),
              },
              { key: "resource", header: t("operations.resource"), cell: (row) => row.name || "—" },
              {
                key: "state",
                header: t("operations.state"),
                cell: (row) => t(`operations.states.${pick(KNOWN_STATES, row.state)}`),
              },
              {
                key: "date",
                header: t("operations.date"),
                cell: (row) => (
                  <DateText value={row.createdAt} variant="datetime" numerals={numerals} />
                ),
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}
