import { Button, Card, DataTable, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { BucketListScreen, BucketRow } from "../../../../server/bucket-view.ts";
import { BucketState, useRegionLabel } from "./StorageParts.tsx";

// The content of /storage (16.10): DataTable and EmptyState. The markup follows cart.html and 404.html
// through the kit (see mockup-anchors.ts). The bucket name is shown because it is part of the bucket
// address (U6).

export function StorageContent({ locale, screen }: { locale: Locale; screen: BucketListScreen }) {
  const t = useTranslations("Storage");
  const regionLabel = useRegionLabel();
  const newHref = localePath(locale, "/storage/new");

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
      cell: (row: BucketRow) => (
        <a href={localePath(locale, `/storage/${row.id}`)}>
          {row.name === "" ? t("list.none") : row.name}
        </a>
      ),
    },
    {
      key: "bucket",
      header: t("list.bucket"),
      cell: (row: BucketRow) => row.bucketName ?? t("list.none"),
    },
    {
      key: "location",
      header: t("list.location"),
      cell: (row: BucketRow) => regionLabel(row.region),
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: BucketRow) => <BucketState state={row.state} />,
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
