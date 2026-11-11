import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { DataTable, type DataTableColumn } from "../../components/DataTable.tsx";
import { AwsLines } from "../../shells/parts/AwsLines.tsx";
import { Logo } from "../../shells/parts/Logo.tsx";
import { Sample } from "../Sample.tsx";

// The rows of the table "Names in customer-facing text" in 16.13. The last two show no AWS name.
const NAMES = [
  "instance",
  "database",
  "disk",
  "bucket",
  "loadBalancer",
  "container",
  "cdn",
  "staticIp",
  "snapshot",
  "bundle",
  "blueprint",
  "region",
  "dns",
  "topUp",
  "basePrice",
] as const;
const WITHOUT_AWS_NAME: readonly string[] = ["topUp", "basePrice"];

interface NameRow {
  id: string;
  product: string;
  aws: string;
}

export function Aws(): ReactElement {
  const t = useTranslations("Gallery");
  const rows: NameRow[] = NAMES.map((id) => ({
    id,
    product: t(`names.${id}.product`),
    aws: WITHOUT_AWS_NAME.includes(id) ? t("demo.aws.none") : t(`names.${id}.aws`),
  }));
  const columns: DataTableColumn<NameRow>[] = [
    { key: "product", header: t("demo.aws.colProduct"), cell: (row) => row.product },
    { key: "aws", header: t("demo.aws.colAws"), cell: (row) => row.aws },
  ];
  return (
    <>
      <Sample name="AwsLines" titleKey="Gallery.samples.awsLines">
        <h4 className="h6 mergecolor">{t("demo.aws.shortTitle")}</h4>
        <AwsLines variant="short" />
        <h4 className="h6 mergecolor">{t("demo.aws.longTitle")}</h4>
        <AwsLines variant="long" />
      </Sample>
      <Sample name="Logo" titleKey="Gallery.samples.logo">
        <Logo />
      </Sample>
      <Sample name="ProductNames" titleKey="Gallery.samples.productNames">
        <DataTable
          caption={t("demo.aws.caption")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      </Sample>
    </>
  );
}
