import { Button, Card, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type {
  LoadBalancerListScreen,
  LoadBalancerRow,
} from "../../../../server/load-balancers-view.ts";
import { FamilyState } from "../_family/FamilyParts.tsx";
import { useRegionLabel } from "../servers/ServerParts.tsx";

// The content of /load-balancers (16.10): DataTable and EmptyState. The markup follows cart.html and
// 404.html through the kit (see mockup-anchors.ts).

export function LoadBalancersContent({
  locale,
  screen,
}: {
  locale: Locale;
  screen: LoadBalancerListScreen;
}) {
  const t = useTranslations("LoadBalancers");
  const regionLabel = useRegionLabel();
  const newHref = localePath(locale, "/load-balancers/new");

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
      cell: (row: LoadBalancerRow) => (
        <a href={localePath(locale, `/load-balancers/${row.id}`)}>
          {row.name === "" ? t("list.none") : row.name}
        </a>
      ),
    },
    {
      key: "location",
      header: t("list.location"),
      cell: (row: LoadBalancerRow) => regionLabel(row.region),
    },
    {
      key: "targets",
      header: t("list.targets"),
      cell: (row: LoadBalancerRow) => String(row.targetCount),
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: LoadBalancerRow) => <FamilyState ns="LoadBalancers" state={row.state} />,
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
