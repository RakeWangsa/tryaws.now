import { Button, Card, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { ContainerListScreen, ContainerRow } from "../../../../server/container-view.ts";
import { ContainerState, useRegionLabel } from "./ContainerParts.tsx";

// The content of /containers (16.10): DataTable and EmptyState. The markup follows cart.html and
// 404.html through the kit (see container-anchors.ts). The public address is shown because the
// customer needs it (U6).

export function ContainersContent({
  locale,
  screen,
}: {
  locale: Locale;
  screen: ContainerListScreen;
}) {
  const t = useTranslations("Containers");
  const regionLabel = useRegionLabel();
  const newHref = localePath(locale, "/containers/new");

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
      cell: (row: ContainerRow) => (
        <a href={localePath(locale, `/containers/${row.id}`)}>
          {row.name === "" ? t("list.none") : row.name}
        </a>
      ),
    },
    {
      key: "location",
      header: t("list.location"),
      cell: (row: ContainerRow) => regionLabel(row.region),
    },
    {
      key: "url",
      header: t("list.url"),
      cell: (row: ContainerRow) => row.publicUrl ?? t("list.none"),
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: ContainerRow) => <ContainerState state={row.state} />,
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
