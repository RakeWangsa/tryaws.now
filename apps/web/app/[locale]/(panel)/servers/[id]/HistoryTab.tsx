import { DataTable, DateText, EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { HistoryItem, HistoryScreen } from "../../../../../server/resource-history.ts";

// The History tab of a resource (WPU-N1): when, what and the status of each request, newest first.
// Synchronous, so it renders in a test without a request. Only the closed lists of kinds and states
// are shown; no internal step and no error text (U6).

type Numerals = "beng" | "latn";

export function HistoryTab({ screen, numerals }: { screen: HistoryScreen; numerals: Numerals }) {
  const t = useTranslations("History");
  if (screen.state === "error") {
    return <EmptyState title={t("error.title")} description={t("error.body")} />;
  }
  return (
    <>
      <p className="seccolor">{t("intro")}</p>
      {screen.items.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        <DataTable
          caption={t("caption")}
          rows={screen.items}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "when",
              header: t("columns.when"),
              cell: (row: HistoryItem) => <DateText value={row.at} numerals={numerals} />,
            },
            {
              key: "action",
              header: t("columns.action"),
              cell: (row: HistoryItem) => t(`kind.${row.kind}`),
            },
            {
              key: "state",
              header: t("columns.state"),
              cell: (row: HistoryItem) => t(`state.${row.state}`),
            },
          ]}
        />
      )}
    </>
  );
}
