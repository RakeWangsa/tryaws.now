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
import {
  DETAIL_KEYS,
  type ReconciliationListResult,
  type ReconciliationOverview,
  type ReconciliationRow,
} from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import type { Loaded, ReconciliationQuery } from "../../server/case-data.ts";
import { reconciliationAction } from "../../server/case-actions.ts";
import { Hidden, ResultNote, StatusBadge, Unavailable, type ResultCode } from "./CaseParts.tsx";

const KINDS = ["orphan", "missing", "cost", "payment"] as const;

function hrefOf(locale: Locale, query: ReconciliationQuery, after: string | null): string {
  const params = new URLSearchParams();
  if (query.kind !== null) params.set("kind", query.kind);
  if (query.status === null) params.set("status", "all");
  else if (query.status !== "open") params.set("status", query.status);
  if (after !== null) params.set("after", after);
  const text = params.toString();
  return `${localePath(locale, "/reconciliation")}${text === "" ? "" : `?${text}`}`;
}

function Overview({
  locale,
  overview,
  query,
}: {
  locale: Locale;
  overview: ReconciliationOverview;
  query: ReconciliationQuery;
}) {
  const t = useTranslations("AdminCases.reconciliation");
  return (
    <div className="row">
      {KINDS.map((kind) => (
        <div className="col-md-3" key={kind}>
          <Card title={t(`kind.${kind}`)}>
            <p className="h4 mb-2">{overview[kind]}</p>
            <a href={hrefOf(locale, { ...query, kind, after: null }, null)}>{t("table.details")}</a>
          </Card>
        </div>
      ))}
    </div>
  );
}

function Details({ row }: { row: ReconciliationRow }) {
  const t = useTranslations("AdminCases.reconciliation");
  if (row.details.length === 0) return <>{t("table.noDetails")}</>;
  return (
    <ul className="list-unstyled mb-0">
      {row.details.map((entry) => (
        <li key={entry.key}>
          {(DETAIL_KEYS as readonly string[]).includes(entry.key)
            ? t(`detailKey.${entry.key as "note"}`)
            : entry.key}
          : {entry.value}
        </li>
      ))}
    </ul>
  );
}

function ResolveForm({ locale, row }: { locale: Locale; row: ReconciliationRow }) {
  const t = useTranslations("AdminCases.reconciliation");
  const reason = useTranslations("AdminCases.reason");
  return (
    <form action={reconciliationAction}>
      <Hidden locale={locale} kind="resolveDiscrepancy" id={row.id} />
      <Field
        name="reason"
        id={`reason-${row.id}`}
        label={reason("label")}
        required
        maxLength={500}
        autoComplete="off"
      />
      <SubmitButton variant="primary" size="sm">
        {t("resolve.submit")}
      </SubmitButton>
    </form>
  );
}

function ListTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: ReconciliationQuery;
  result: ReconciliationListResult;
}) {
  const t = useTranslations("AdminCases.reconciliation");
  if (result.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  const columns: DataTableColumn<ReconciliationRow>[] = [
    { key: "kind", header: t("table.kind"), cell: (row) => t(`kind.${row.kind}`) },
    { key: "details", header: t("table.details"), cell: (row) => <Details row={row} /> },
    {
      key: "status",
      header: t("table.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "created",
      header: t("table.created"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "resolve",
      header: t("table.resolve"),
      cell: (row) => (row.status === "open" ? <ResolveForm locale={locale} row={row} /> : "-"),
    },
  ];
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={result.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={result.nextAfter === null ? null : hrefOf(locale, query, result.nextAfter)}
    />
  );
}

function Filter({ locale, query }: { locale: Locale; query: ReconciliationQuery }) {
  const t = useTranslations("AdminCases.reconciliation");
  const f = useTranslations("AdminCases.filter");
  const s = useTranslations("AdminCases.status");
  return (
    <form method="get" action={localePath(locale, "/reconciliation")} className="mb-4">
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="kind-filter">
          {t("filter.kind")}
        </label>
        <select
          id="kind-filter"
          name="kind"
          className="form-control"
          defaultValue={query.kind ?? ""}
        >
          <option value="">{t("filter.allKinds")}</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`kind.${kind}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="position-relative mb-3">
        <label className="seccolor" htmlFor="state-filter">
          {f("status")}
        </label>
        <select
          id="state-filter"
          name="status"
          className="form-control"
          defaultValue={query.status ?? "all"}
        >
          <option value="open">{f("open")}</option>
          <option value="resolved">{s("resolved")}</option>
          <option value="all">{f("all")}</option>
        </select>
      </div>
      <Button type="submit" variant="primary" size="sm">
        {f("submit")}
      </Button>
    </form>
  );
}

export interface ReconciliationViewProps {
  locale: Locale;
  query: ReconciliationQuery;
  data: Loaded<{ overview: ReconciliationOverview; list: ReconciliationListResult }>;
  result: ResultCode | null;
}

// 16.12 /reconciliation: discrepancies by kind. ops, finance and superadmin.
export function ReconciliationView({ locale, query, data, result }: ReconciliationViewProps) {
  const t = useTranslations("AdminCases.reconciliation");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="mb-3">{t("intro")}</p>
      <ResultNote result={result} />
      {data.kind === "ok" ? (
        <>
          <Overview locale={locale} overview={data.value.overview} query={query} />
          <Card>
            <Filter locale={locale} query={query} />
          </Card>
          <ListTable locale={locale} query={query} result={data.value.list} />
        </>
      ) : (
        <Unavailable />
      )}
    </>
  );
}
