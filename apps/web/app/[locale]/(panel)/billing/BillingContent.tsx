import {
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  MoneyText,
  StatTile,
  formatDate,
  formatMoney,
} from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { BillingItem, BillingScreen } from "../../../../server/account-view.ts";

// The content of /billing (WPU-G5): the wallet, what runs now, the cost of one term per product and
// per service, and the next renewal. Like the usage page of the Lightsail console, but prepaid:
// there is no hourly meter, the unit is the 30-day term. Money is bigint paisa (R4). Server
// Component; nothing here shows an account id, an ARN or an AWS error (U6).

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
const KNOWN_STATUSES = ["active", "grace", "retained", "ended"];
const pick = (list: readonly string[], value: string): string =>
  list.includes(value) ? value : "other";

export function BillingContent({
  locale,
  numerals,
  screen,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: BillingScreen;
}) {
  const t = useTranslations("Billing");
  const usage = screen.usage;
  const topUp = localePath(locale, "/wallet/topup");

  const alerts: { key: string; text: string; tone: "warning" | "danger" }[] = [];
  if (screen.lowBalance) alerts.push({ key: "low", text: t("alerts.low"), tone: "danger" });
  if (usage.autoRenewOff > 0) {
    alerts.push({
      key: "auto",
      text: t("alerts.autoOff", { count: usage.autoRenewOff }),
      tone: "warning",
    });
  }
  if (usage.unpriced > 0) {
    alerts.push({
      key: "unpriced",
      text: t("alerts.unpriced", { count: usage.unpriced }),
      tone: "warning",
    });
  }

  return (
    <>
      <h1 className="mergecolor h3 mb-3">{t("heading")}</h1>
      <p className="seccolor">{t("intro")}</p>
      <div className="d-flex flex-wrap gap-2 mb-4">
        <Button variant="primary" href={topUp}>
          {t("topUp")}
        </Button>
        <Button variant="default" href={localePath(locale, "/wallet")}>
          {t("links.wallet")}
        </Button>
        <Button variant="default" href={localePath(locale, "/invoices")}>
          {t("links.invoices")}
        </Button>
      </div>
      <div className="row g-3 mb-4">
        <div className="col-12 col-md-6 col-lg-3">
          <StatTile
            value={formatMoney(screen.balanceMinor, { locale, mode: "exact", numerals })}
            description={t("balance")}
          />
        </div>
        <div className="col-12 col-md-6 col-lg-3">
          <StatTile value={String(usage.running)} description={t("running")} />
        </div>
        <div className="col-12 col-md-6 col-lg-3">
          <StatTile
            value={formatMoney(usage.totalMinor, { locale, mode: "exact", numerals })}
            description={t("term")}
          />
        </div>
        <div className="col-12 col-md-6 col-lg-3">
          <StatTile
            value={
              usage.nextRenewal === null
                ? t("nextNone")
                : formatDate(usage.nextRenewal, { locale, numerals })
            }
            description={t("next")}
          />
        </div>
      </div>

      {alerts.map((alert) => (
        <div key={alert.key} className={`alert alert-${alert.tone} text-start`} role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {alert.text}
        </div>
      ))}

      {screen.items.length === 0 ? (
        <EmptyState
          title={t("empty.title")}
          description={t("empty.body")}
          action={
            <Button variant="primary" href={localePath(locale, "/servers/new")}>
              {t("empty.create")}
            </Button>
          }
        />
      ) : (
        <>
          <Card className="mb-4">
            <h2 className="mergecolor h4">{t("byProduct.title")}</h2>
            <DataTable
              caption={t("byProduct.caption")}
              rows={usage.families}
              rowKey={(row) => row.family}
              columns={[
                {
                  key: "product",
                  header: t("byProduct.product"),
                  cell: (row) => t(`byProduct.name.${pick(KNOWN_FAMILIES, row.family)}`),
                },
                { key: "count", header: t("byProduct.count"), cell: (row) => String(row.count) },
                {
                  key: "amount",
                  header: t("byProduct.amount"),
                  cell: (row) => (
                    <MoneyText minor={row.totalMinor} mode="exact" numerals={numerals} />
                  ),
                },
              ]}
            />
          </Card>
          <Card className="mb-4">
            <h2 className="mergecolor h4">{t("byResource.title")}</h2>
            <DataTable
              caption={t("byResource.caption")}
              rows={screen.items}
              rowKey={(row) => row.resourceId}
              columns={[
                {
                  key: "name",
                  header: t("byResource.name"),
                  cell: (row: BillingItem) =>
                    row.family === "linux_instance" || row.family === "windows_instance" ? (
                      <a
                        href={localePath(locale, `/servers/${encodeURIComponent(row.resourceId)}`)}
                      >
                        {row.name === "" ? t("byResource.unnamed") : row.name}
                      </a>
                    ) : row.name === "" ? (
                      t("byResource.unnamed")
                    ) : (
                      row.name
                    ),
                },
                {
                  key: "product",
                  header: t("byResource.product"),
                  cell: (row: BillingItem) =>
                    t(`byProduct.name.${pick(KNOWN_FAMILIES, row.family)}`),
                },
                {
                  key: "status",
                  header: t("byResource.status"),
                  cell: (row: BillingItem) =>
                    t(`byResource.statuses.${pick(KNOWN_STATUSES, row.status)}`),
                },
                {
                  key: "end",
                  header: t("byResource.periodEnd"),
                  cell: (row: BillingItem) => (
                    <DateText value={row.periodEnd} numerals={numerals} />
                  ),
                },
                {
                  key: "auto",
                  header: t("byResource.autoRenew"),
                  cell: (row: BillingItem) =>
                    row.autoRenew ? t("byResource.on") : t("byResource.off"),
                },
                {
                  key: "amount",
                  header: t("byResource.amount"),
                  cell: (row: BillingItem) =>
                    row.amountMinor === null ? (
                      t("byResource.unpriced")
                    ) : (
                      <MoneyText minor={row.amountMinor} mode="exact" numerals={numerals} />
                    ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
