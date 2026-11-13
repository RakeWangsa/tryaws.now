import { Button, DataTable, DateText, EmptyState, StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { CustomerSupportRequestRow } from "../../../../../server/support-view.ts";

// The content of /support/requests (WPU-Z6): the customer's support requests, the newest activity first
// (the order of the repository), with subject, type, status and last activity, and a "New request" button.
// The table follows supportticketslist.tpl through the kit (rows become cards below 768 px). Synchronous,
// so it renders in a test without a request. Subjects are plain text (React escapes them).

type Numerals = "beng" | "latn";
type Status = CustomerSupportRequestRow["status"];

// The status is a word with an icon, never a color alone (U11). The WHMCS status label classes of the mockup
// (label status status-open) live in a stylesheet the product does not ship, so the kit's state badge
// carries the three states.
const STATUS_LOOK: Record<Status, BadgeState> = {
  open: "pending",
  answered: "paid",
  closed: "retained",
};

// Final review (Z6 minors): a status the screen does not know (a newer state, a bad row) is named "Status
// unknown", never an empty badge.
export function SupportStatusBadge({ status }: { status: Status }) {
  const t = useTranslations("SupportForm.status");
  const known = Object.hasOwn(STATUS_LOOK, status);
  return (
    <StateBadge
      state={known ? STATUS_LOOK[status] : "pending"}
      label={known && t.has(status) ? t(status) : t("unknown")}
    />
  );
}

export const threadHref = (locale: Locale, id: string): string =>
  localePath(locale, `/support/requests/${encodeURIComponent(id)}`);

export function NewRequestButton({ locale }: { locale: Locale }) {
  const t = useTranslations("SupportRequests");
  return (
    <Button variant="primary" icon="fas fa-plus" href={localePath(locale, "/support/new")}>
      {t("newRequest")}
    </Button>
  );
}

export function RequestsContent({
  locale,
  numerals,
  requests,
}: {
  locale: Locale;
  numerals: Numerals;
  requests: readonly CustomerSupportRequestRow[];
}) {
  const t = useTranslations("SupportRequests");
  const form = useTranslations("SupportForm");

  if (requests.length === 0) {
    return (
      <EmptyState
        title={t("list.empty.title")}
        description={t("list.empty.body")}
        action={<NewRequestButton locale={locale} />}
      />
    );
  }

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-4">
        <p className="seccolor mb-2">{t("intro")}</p>
        <NewRequestButton locale={locale} />
      </div>
      <DataTable
        caption={t("list.caption")}
        rows={[...requests]}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "subject",
            header: t("list.subject"),
            cell: (row: CustomerSupportRequestRow) => (
              <a className="mergecolor text-break" href={threadHref(locale, row.id)}>
                {row.subject}
              </a>
            ),
          },
          {
            key: "category",
            header: t("list.category"),
            cell: (row: CustomerSupportRequestRow) =>
              form.has(`form.category.${row.category}`)
                ? form(`form.category.${row.category}`)
                : "",
          },
          {
            key: "status",
            header: t("list.status"),
            cell: (row: CustomerSupportRequestRow) => <SupportStatusBadge status={row.status} />,
          },
          {
            key: "lastActivity",
            header: t("list.lastActivity"),
            cell: (row: CustomerSupportRequestRow) => (
              <DateText value={row.lastActivityAt} variant="datetime" numerals={numerals} />
            ),
          },
        ]}
      />
    </>
  );
}
