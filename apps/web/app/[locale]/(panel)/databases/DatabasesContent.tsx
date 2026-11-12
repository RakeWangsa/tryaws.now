import { Button, Card, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { DatabaseListScreen, DatabaseRow } from "../../../../server/databases-view.ts";
import { FamilyState } from "../_family/FamilyParts.tsx";
import { useRegionLabel } from "../servers/ServerParts.tsx";
import { useEngineLabel } from "./DatabaseParts.tsx";

// The content of /databases (16.10): DataTable and EmptyState. The markup follows cart.html and
// 404.html through the kit (see mockup-anchors.ts). The endpoint is shown because the customer needs
// it to connect (U6).

export function DatabasesContent({
  locale,
  screen,
}: {
  locale: Locale;
  screen: DatabaseListScreen;
}) {
  const t = useTranslations("Databases");
  const regionLabel = useRegionLabel();
  const engineLabel = useEngineLabel();
  const newHref = localePath(locale, "/databases/new");

  if (screen.state === "flag_off") {
    // R12: the flag is off. 16.13: the coming soon state, with words and no action that could buy.
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.items.length === 0) {
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
      cell: (row: DatabaseRow) => (
        <a href={localePath(locale, `/databases/${row.id}`)}>
          {row.name === "" ? t("list.none") : row.name}
        </a>
      ),
    },
    {
      key: "engine",
      header: t("list.engine"),
      cell: (row: DatabaseRow) => engineLabel(row.specs) ?? t("list.none"),
    },
    {
      key: "location",
      header: t("list.location"),
      cell: (row: DatabaseRow) => regionLabel(row.region),
    },
    {
      key: "endpoint",
      header: t("list.endpoint"),
      cell: (row: DatabaseRow) =>
        row.endpoint === null
          ? t("list.none")
          : row.port === null
            ? row.endpoint
            : `${row.endpoint}:${row.port}`,
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: DatabaseRow) => <FamilyState ns="Databases" state={row.state} />,
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
          rows={screen.items}
          rowKey={(row) => row.id}
        />
      </Card>
    </>
  );
}
