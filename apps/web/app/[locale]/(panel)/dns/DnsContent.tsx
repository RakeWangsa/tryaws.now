import { Button, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useFormatter, useTranslations } from "next-intl";
import type { ZoneListItem, ZoneListScreen } from "../../../../server/dns-view.ts";
import { ZoneStatusBadge } from "./[id]/ZoneContent.tsx";
import { CreateZoneForm, type CreateZoneAction } from "./CreateZoneForm.tsx";

// The content of /dns (WPU-G4, WPU-G6): the DNS zones of the customer, the way into the records of each
// and the form that makes a new zone. States: flag off, empty, ready (loading and error are loading.tsx
// and error.tsx); with the flag off nothing that could make or change a zone is shown (R12). Synchronous, so it
// renders in a test without a request. Nothing here shows the hosted zone id or an account (U6).

export function DnsContent({
  locale,
  screen,
  createAction,
}: {
  locale: Locale;
  screen: ZoneListScreen;
  createAction: CreateZoneAction;
}) {
  const t = useTranslations("Dns");
  const format = useFormatter();

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.state === "empty") {
    return (
      <>
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
        <CreateZoneForm action={createAction} />
      </>
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
            cell: (zone: ZoneListItem) => <ZoneStatusBadge status={zone.status} />,
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
      <div className="mt-4">
        <CreateZoneForm action={createAction} />
      </div>
    </>
  );
}
