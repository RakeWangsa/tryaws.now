import { DataTable, DateText, EmptyState } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { localePath } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../server/action-state.ts";
import type { NotificationsScreen } from "../../../../server/extras-view.ts";
import { MarkReadForm } from "./MarkReadForm.tsx";

type Numerals = "beng" | "latn";

/**
 * The content of /notifications (16.10): the last 50 notifications. The text is rendered from the
 * template in the viewer's locale (packages/notify); a row that cannot be rendered shows one generic
 * line and never its payload (R14). The state is shown by words, not by colour alone (U11).
 */
export function NotificationsContent({
  locale,
  numerals,
  screen,
  action,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: NotificationsScreen;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Notifications");
  if (screen.items.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  return (
    <>
      <h1 className="mergecolor h3 mb-2">{t("heading")}</h1>
      <p className="seccolor">{t("unreadCount", { count: screen.unread })}</p>
      {screen.unread > 0 ? <MarkReadForm action={action} /> : null}
      <DataTable
        caption={t("caption")}
        rows={screen.items}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "message",
            header: t("message"),
            cell: (row) => (
              <>
                <b className="mergecolor">{row.title ?? t("generic")}</b>
                {row.body === null ? null : <span className="d-block seccolor">{row.body}</span>}
                {row.href === null ? null : (
                  <a href={localePath(locale, row.href.replace(/^\/(bn|en)(?=\/|$)/, "") || "/")}>
                    {t("open")}
                  </a>
                )}
              </>
            ),
          },
          {
            key: "date",
            header: t("date"),
            cell: (row) => (
              <DateText value={row.createdAt} variant="datetime" numerals={numerals} />
            ),
          },
          {
            key: "status",
            header: t("status"),
            cell: (row) => (row.read ? t("read") : t("unread")),
          },
        ]}
      />
    </>
  );
}
