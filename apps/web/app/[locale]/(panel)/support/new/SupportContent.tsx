import { Badge, Card, DataTable, DateText, EmptyState } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type {
  CustomerSupportRequestRow,
  SupportResourceChoice,
} from "../../../../../server/support-view.ts";
import { threadHref } from "../requests/RequestsContent.tsx";
import { SupportForm } from "./SupportForm.tsx";
import type { SupportAction } from "./SupportForm.tsx";

// The content of /support/new (16.10): the request form and the customer's earlier requests, or the
// empty state. Synchronous, so it renders in a test without a request. Subjects are plain text
// (React escapes them); the message of a request is never loaded for the list.

type Numerals = "beng" | "latn";

export function SupportContent({
  locale,
  numerals,
  requests,
  resources = [],
  action,
}: {
  locale: Locale;
  numerals: Numerals;
  requests: readonly CustomerSupportRequestRow[];
  resources?: readonly SupportResourceChoice[];
  action: SupportAction;
}) {
  const t = useTranslations("SupportForm");
  return (
    <>
      <p className="seccolor mb-4">{t("intro")}</p>
      <Card title={t("form.title")} className="mb-4">
        <SupportForm action={action} resources={resources} />
      </Card>
      <h2 className="h5 mergecolor mb-3">{t("list.title")}</h2>
      {requests.length === 0 ? (
        <EmptyState title={t("list.empty.title")} description={t("list.empty.body")} />
      ) : (
        <DataTable
          caption={t("list.caption")}
          rows={[...requests]}
          rowKey={(row) => row.id}
          columns={[
            {
              key: "subject",
              header: t("list.subject"),
              // Final review (Z6 minors): each earlier request opens its thread.
              cell: (row) => (
                <a className="mergecolor text-break" href={threadHref(locale, row.id)}>
                  {row.subject}
                </a>
              ),
            },
            {
              key: "category",
              header: t("list.category"),
              cell: (row) =>
                t.has(`form.category.${row.category}`) ? t(`form.category.${row.category}`) : "",
            },
            {
              key: "status",
              header: t("list.status"),
              cell: (row) => (
                <Badge tone={row.status === "open" ? "purple" : "grey"}>
                  {t.has(`status.${row.status}`) ? t(`status.${row.status}`) : ""}
                </Badge>
              ),
            },
            {
              key: "sentOn",
              header: t("list.sentOn"),
              cell: (row) => <DateText value={row.createdAt} numerals={numerals} />,
            },
          ]}
        />
      )}
    </>
  );
}
