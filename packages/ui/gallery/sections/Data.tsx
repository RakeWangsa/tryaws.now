import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Accordion } from "../../components/Accordion.tsx";
import { StateBadge, type BadgeState } from "../../components/Badge.tsx";
import { DataTable, type DataTableColumn } from "../../components/DataTable.tsx";
import { MoneyText } from "../../components/MoneyText.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { DEMO_ROWS } from "../data.ts";
import { Sample } from "../Sample.tsx";

interface DemoRow {
  id: string;
  name: string;
  state: BadgeState;
  priceMinor: bigint;
}

export function Data(): ReactElement {
  const t = useTranslations("Gallery.demo");
  const names: Record<(typeof DEMO_ROWS)[number]["id"], string> = {
    a: t("table.rowA"),
    b: t("table.rowB"),
    c: t("table.rowC"),
  };
  const rows: DemoRow[] = DEMO_ROWS.map((row) => ({ ...row, name: names[row.id] }));
  const columns: DataTableColumn<DemoRow>[] = [
    { key: "name", header: t("table.name"), cell: (row) => row.name },
    { key: "state", header: t("table.state"), cell: (row) => <StateBadge state={row.state} /> },
    {
      key: "price",
      header: t("table.price"),
      cell: (row) => <MoneyText minor={row.priceMinor} mode="exact" />,
    },
  ];
  return (
    <>
      <Sample name="DataTable" titleKey="Gallery.samples.dataTable">
        <DataTable
          caption={t("table.caption")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      </Sample>
      <Sample name="Tabs" titleKey="Gallery.samples.tabs">
        <Tabs
          label={t("tabs.label")}
          tabs={[
            {
              id: "one",
              title: t("tabs.one"),
              content: <p className="seccolor">{t("tabs.bodyOne")}</p>,
            },
            {
              id: "two",
              title: t("tabs.two"),
              content: <p className="seccolor">{t("tabs.bodyTwo")}</p>,
            },
          ]}
        />
      </Sample>
      <Sample name="Accordion" titleKey="Gallery.samples.accordion">
        <Accordion
          defaultOpenId="q1"
          headingLevel={4}
          items={[
            { id: "q1", title: t("accordion.q1"), content: t("accordion.a1") },
            { id: "q2", title: t("accordion.q2"), content: t("accordion.a2") },
            { id: "q3", title: t("accordion.q3"), content: t("accordion.a3") },
          ]}
        />
      </Sample>
    </>
  );
}
