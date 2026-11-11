import { useTranslations } from "next-intl";
import {
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type { SupportListResult, SupportRequestDetail, SupportRequestRow } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import type { CaseQuery, Loaded } from "../../server/case-data.ts";
import { supportAction } from "../../server/case-actions.ts";
import {
  Hidden,
  listHref,
  ReasonField,
  ResultNote,
  StatusBadge,
  StatusFilter,
  TrailCard,
  Unavailable,
  type ResultCode,
} from "./CaseParts.tsx";

function ListTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: CaseQuery;
  result: SupportListResult;
}) {
  const t = useTranslations("AdminCases.support");
  if (result.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  const columns: DataTableColumn<SupportRequestRow>[] = [
    {
      key: "subject",
      header: t("table.subject"),
      cell: (row) => <a href={localePath(locale, `/support/${row.id}`)}>{row.subject}</a>,
    },
    { key: "who", header: t("table.requester"), cell: (row) => row.name ?? t("table.noName") },
    { key: "email", header: t("table.email"), cell: (row) => row.emailMasked ?? "-" },
    { key: "category", header: t("table.category"), cell: (row) => row.category },
    {
      key: "status",
      header: t("table.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "handler",
      header: t("table.handler"),
      cell: (row) => (row.handledBy === null ? t("table.none") : t("table.mine")),
    },
    {
      key: "created",
      header: t("table.created"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
  ];
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={result.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={
        result.nextAfter === null ? null : listHref(locale, "/support", query, result.nextAfter)
      }
    />
  );
}

export interface SupportListViewProps {
  locale: Locale;
  query: CaseQuery;
  list: Loaded<SupportListResult>;
  result: ResultCode | null;
}

// 16.12 /support: the requests of customers and visitors; the address is masked (R14).
export function SupportListView({ locale, query, list, result }: SupportListViewProps) {
  const t = useTranslations("AdminCases.support");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <ResultNote result={result} />
      <Card>
        <StatusFilter action={localePath(locale, "/support")} query={query} />
      </Card>
      {list.kind === "ok" ? (
        <ListTable locale={locale} query={query} result={list.value} />
      ) : (
        <Unavailable />
      )}
    </>
  );
}

export interface SupportDetailViewProps {
  locale: Locale;
  request: SupportRequestDetail;
  result: ResultCode | null;
  // False while the email template is not registered: the reply form is then replaced by a hint.
  replyEnabled: boolean;
  // The idempotency key of one reply form: a second submit of the same form is a replay (R7).
  replyId: string;
}

// 16.12 /support/[id].
export function SupportDetailView({
  locale,
  request,
  result,
  replyEnabled,
  replyId,
}: SupportDetailViewProps) {
  const t = useTranslations("AdminCases.support");
  const open = request.status === "open";
  return (
    <>
      <h2 className="h4 mergecolor">{request.subject}</h2>
      <p>
        <Button
          href={localePath(locale, "/support")}
          variant="tertiary"
          size="sm"
          icon="fas fa-arrow-left"
        >
          {t("detail.back")}
        </Button>
      </p>
      <ResultNote result={result} />
      <Card title={t("detail.info")}>
        <dl className="mb-0">
          <dt>{t("table.requester")}</dt>
          <dd>
            {request.name ?? t("table.noName")} (
            {request.customerId === null ? t("detail.visitor") : t("detail.customer")})
          </dd>
          <dt>{t("table.email")}</dt>
          <dd>{request.emailMasked ?? "-"}</dd>
          <dt>{t("table.category")}</dt>
          <dd>{request.category}</dd>
          <dt>{t("table.status")}</dt>
          <dd>
            <StatusBadge status={request.status} />
          </dd>
          {request.customerId === null ? null : (
            <>
              <dt>{t("detail.customer")}</dt>
              <dd>
                <a href={localePath(locale, `/customers/${request.customerId}`)}>
                  {request.customerId.slice(0, 8)}
                </a>
              </dd>
            </>
          )}
          {request.relatedResourceId === null ? null : (
            <>
              <dt>{t("detail.relatedResource")}</dt>
              <dd>{request.relatedResourceId}</dd>
            </>
          )}
          <dt>{t("table.created")}</dt>
          <dd>
            <DateText value={request.createdAt} variant="datetime" />
          </dd>
        </dl>
      </Card>
      <Card title={t("detail.message")}>
        <p className="mb-0">{request.message}</p>
      </Card>
      <div className="row">
        <div className="col-lg-6">
          <Card title={t("reply.title")}>
            {!open ? (
              <p className="mb-0">{t("reply.closedHint")}</p>
            ) : !replyEnabled ? (
              <p className="mb-0">{t("reply.disabled")}</p>
            ) : (
              <form action={supportAction}>
                <Hidden locale={locale} kind="replyByEmail" id={request.id} extra={{ replyId }} />
                <Field
                  name="body"
                  id="reply-body"
                  label={t("reply.label")}
                  hint={t("reply.hint")}
                  multiline
                  rows={6}
                  required
                  maxLength={5000}
                />
                <SubmitButton variant="primary" size="sm">
                  {t("reply.submit")}
                </SubmitButton>
              </form>
            )}
          </Card>
        </div>
        <div className="col-lg-6">
          <Card title={t("close.title")}>
            {open ? (
              <form action={supportAction}>
                <Hidden locale={locale} kind="closeRequest" id={request.id} />
                <ReasonField suffix="close" />
                <SubmitButton variant="destructive" size="sm">
                  {t("close.submit")}
                </SubmitButton>
              </form>
            ) : (
              <StatusBadge status={request.status} />
            )}
          </Card>
        </div>
      </div>
      <TrailCard
        rows={request.audit}
        labels={{
          title: t("detail.trail"),
          empty: t("detail.trailEmpty"),
          action: t("detail.action"),
          by: t("detail.by"),
          reason: t("detail.reasonColumn"),
          when: t("detail.when"),
        }}
      />
    </>
  );
}
