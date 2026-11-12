import { Button, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useFormatter, useTranslations } from "next-intl";
import type { ZoneListItem, ZoneListScreen } from "../../../../server/dns-view.ts";
import { ZoneStateBadge } from "./[id]/ZoneContent.tsx";

// The content of /dns (WPU-G4): the DNS zones of the customer and the way into the records of each.
// States: flag off, empty, ready (loading and error are loading.tsx and error.tsx). Synchronous, so it
// renders in a test without a request. Nothing here shows the hosted zone id or an account (U6).

export function DnsContent({ locale, screen }: { locale: Locale; screen: ZoneListScreen }) {
  const t = useTranslations("Dns");
  const format = useFormatter();

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.state === "empty") {
    return (
      <EmptyState
        title={t("empty.title")}
        description={t("empty.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/domains")}>
            {t("empty.action")}
          </Button>
        }
      />
    );
  }
  return (
    <>
      <p className="seccolor mb-4">{t("awsNote")}</p>
      <DataTable
        caption={t("list.caption")}
        rows={screen.zones}
        rowKey={(zone) => zone.id}
        columns={[
          { key: "name", header: t("list.name"), cell: (zone: ZoneListItem) => zone.name },
          {
            key: "state",
            header: t("list.state"),
            cell: (zone: ZoneListItem) => <ZoneStateBadge state={zone.state} />,
          },
          {
            key: "records",
            header: t("list.records"),
            cell: (zone: ZoneListItem) =>
              zone.recordCount === null
                ? t("list.unknownRecords")
                : format.number(zone.recordCount),
          },
          {
            key: "manage",
            header: t("list.manage"),
            cell: (zone: ZoneListItem) => (
              <Button
                variant="default"
                size="sm"
                href={localePath(locale, `/dns/${encodeURIComponent(zone.id)}`)}
              >
                {t("list.manage")}
              </Button>
            ),
          },
        ]}
      />
    </>
  );
}
