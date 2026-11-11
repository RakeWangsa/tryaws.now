import { Button, Card, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { ServerRow, ServersScreen } from "../../../../server/servers-view.ts";
import { ServerState, useRegionLabel, useSpecLine } from "./ServerParts.tsx";

// The content of /servers (16.10): DataTable and EmptyState. The markup follows cart.html and
// 404.html through the kit (see mockup-anchors.ts).

export function ServersContent({ locale, screen }: { locale: Locale; screen: ServersScreen }) {
  const t = useTranslations("Servers");
  const specLine = useSpecLine();
  const regionLabel = useRegionLabel();
  const newHref = localePath(locale, "/servers/new");

  if (screen.state === "flag_off") {
    // R12: the flag is off. 16.13: the coming soon state, with words and no action that could buy.
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.servers.length === 0) {
    return (
      <EmptyState
        title={t("list.empty.title")}
        description={t("list.empty.body")}
        action={
          <Button variant="primary" href={newHref}>
            {t("list.create")}
          </Button>
        }
      />
    );
  }

  const columns = [
    {
      key: "name",
      header: t("list.name"),
      cell: (row: ServerRow) => (
        <a href={localePath(locale, `/servers/${row.id}`)}>
          {row.name === "" ? t("list.none") : row.name}
        </a>
      ),
    },
    {
      key: "plan",
      header: t("list.plan"),
      cell: (row: ServerRow) => specLine(row.specs) || t("list.none"),
    },
    {
      key: "location",
      header: t("list.location"),
      cell: (row: ServerRow) => regionLabel(row.region),
    },
    { key: "ip", header: t("list.ip"), cell: (row: ServerRow) => row.publicIp ?? t("list.none") },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: ServerRow) => <ServerState state={row.state} />,
    },
  ];

  return (
    <>
      <p className="seccolor mb-3">{t("awsNote")}</p>
      <div className="mb-3">
        <Button variant="primary" href={newHref} icon="fas fa-plus">
          {t("list.create")}
        </Button>
      </div>
      <Card>
        <DataTable
          caption={t("list.caption")}
          columns={columns}
          rows={screen.servers}
          rowKey={(row) => row.id}
        />
      </Card>
    </>
  );
}
