import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  type DataTableColumn,
} from "@tc/ui";
import type { AuditRow, AuditSearchResult } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { auditParams, type AuditQuery } from "../../server/audit-query.ts";
import type { Loaded } from "../../server/money-data.ts";

// 16.12 /audit and /audit/[id]. Nothing here posts: the filter and the CSV export are GET forms. The
// export form carries the filter as hidden fields and asks for the reason of R10; the route audits it.
// The rows are masked by the repository before they get here (R14).
const ACTOR_TYPES = ["admin", "customer", "system"] as const;

function ShortId({ id }: { id: string }) {
  return <span title={id}>#{id.slice(0, 8)}</span>;
}

function listHref(locale: Locale, query: AuditQuery, after: string | null): string {
  const text = auditParams(query, after).toString();
  return `${localePath(locale, "/audit")}${text === "" ? "" : `?${text}`}`;
}

function FilterForm({ locale, query }: { locale: Locale; query: AuditQuery }) {
  const t = useTranslations("AdminAudit");
  return (
    <form method="get" action={localePath(locale, "/audit")} className="mb-4">
      <FormBlock>
        <Field
          name="actor"
          id="audit-actor"
          label={t("filters.actor")}
          hint={t("filters.actorHint")}
          defaultValue={query.actorId ?? ""}
          optional
          maxLength={36}
          autoComplete="off"
        />
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="audit-actor-type">
            {t("filters.actorType")}
          </label>
          <select
            id="audit-actor-type"
            name="actorType"
            className="form-control"
            defaultValue={query.actorType ?? ""}
          >
            <option value="">{t("filters.all")}</option>
            {ACTOR_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`actorTypes.${type}`)}
              </option>
            ))}
          </select>
        </div>
        <Field
          name="targetType"
          id="audit-target-type"
          label={t("filters.targetType")}
          hint={t("filters.targetTypeHint")}
          defaultValue={query.targetType ?? ""}
          optional
          maxLength={40}
          autoComplete="off"
        />
        <Field
          name="targetId"
          id="audit-target-id"
          label={t("filters.targetId")}
          defaultValue={query.targetId ?? ""}
          optional
          maxLength={100}
          autoComplete="off"
        />
        <Field
          name="action"
          id="audit-action"
          label={t("filters.action")}
          hint={t("filters.actionHint")}
          defaultValue={query.action ?? ""}
          optional
          maxLength={80}
          autoComplete="off"
        />
        <Field
          name="from"
          id="audit-from"
          label={t("filters.from")}
          hint={t("filters.dateHint")}
          defaultValue={query.from ?? ""}
          optional
          maxLength={10}
          autoComplete="off"
        />
        <Field
          name="to"
          id="audit-to"
          label={t("filters.to")}
          hint={t("filters.dateHint")}
          defaultValue={query.to ?? ""}
          optional
          maxLength={10}
          autoComplete="off"
        />
      </FormBlock>
      <Button type="submit" variant="primary" size="sm">
        {t("filters.submit")}
      </Button>{" "}
      <Button href={localePath(locale, "/audit")} variant="tertiary" size="sm">
        {t("filters.reset")}
      </Button>
    </form>
  );
}

function ActorCell({ row }: { row: AuditRow }) {
  const t = useTranslations("AdminAudit");
  const type = (ACTOR_TYPES as readonly string[]).includes(row.actorType)
    ? t(`actorTypes.${row.actorType as "admin"}`)
    : row.actorType;
  return (
    <>
      <Badge tone={row.actorType === "admin" ? "purple" : "grey"}>{type}</Badge>{" "}
      {row.actorId === null ? null : <ShortId id={row.actorId} />}
    </>
  );
}

function AuditTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: AuditQuery;
  result: AuditSearchResult;
}) {
  const t = useTranslations("AdminAudit");
  const columns: DataTableColumn<AuditRow>[] = [
    {
      key: "when",
      header: t("table.when"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    { key: "actor", header: t("table.actor"), cell: (row) => <ActorCell row={row} /> },
    { key: "action", header: t("table.action"), cell: (row) => row.action },
    {
      key: "target",
      header: t("table.target"),
      cell: (row) =>
        row.targetType === null && row.targetId === null
          ? "-"
          : `${row.targetType ?? ""} ${row.targetId ?? ""}`.trim(),
    },
    { key: "ip", header: t("table.ip"), cell: (row) => row.ip ?? "-" },
    {
      key: "open",
      header: t("table.open"),
      cell: (row) => <a href={localePath(locale, `/audit/${row.id}`)}>{t("table.open")}</a>,
    },
  ];
  if (result.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={result.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={result.nextAfter === null ? null : listHref(locale, query, result.nextAfter)}
    />
  );
}

export interface AuditViewProps {
  locale: Locale;
  query: AuditQuery;
  list: Loaded<AuditSearchResult>;
  canExport: boolean;
}

export function AuditView({ locale, query, list, canExport }: AuditViewProps) {
  const t = useTranslations("AdminAudit");
  const exportFilter = [...auditParams(query, null).entries()];
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="form-text seccolor">{t("intro")}</p>
      <Card>
        <FilterForm locale={locale} query={query} />
        {canExport ? (
          <form method="get" action="/api/audit-export" className="mb-0">
            {exportFilter.map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <FormBlock>
              <Field
                name="reason"
                id="audit-export-reason"
                label={t("export.reasonLabel")}
                hint={t("export.reasonHint")}
                required
                maxLength={500}
                autoComplete="off"
              />
            </FormBlock>
            <Button type="submit" variant="tertiary" size="sm" icon="fas fa-download">
              {t("export.link")}
            </Button>
            <span className="form-text seccolor d-block">{t("export.hint")}</span>
          </form>
        ) : null}
      </Card>
      {list.kind === "ok" ? (
        <AuditTable locale={locale} query={query} result={list.value} />
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
    </>
  );
}

function Json({ value }: { value: unknown }) {
  const t = useTranslations("AdminAudit");
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value as object).length === 0);
  if (empty) return <p className="mb-0">{t("detail.none")}</p>;
  return <pre className="mb-0">{JSON.stringify(value, null, 2)}</pre>;
}

export function AuditDetailView({ locale, row }: { locale: Locale; row: AuditRow }) {
  const t = useTranslations("AdminAudit");
  const type = (ACTOR_TYPES as readonly string[]).includes(row.actorType)
    ? t(`actorTypes.${row.actorType as "admin"}`)
    : row.actorType;
  return (
    <>
      <h2 className="h4 mergecolor">{t("detail.title")}</h2>
      <p>
        <Button
          href={localePath(locale, "/audit")}
          variant="tertiary"
          size="sm"
          icon="fas fa-arrow-left"
        >
          {t("detail.back")}
        </Button>
      </p>
      <Card>
        <dl className="mb-0">
          <dt>{t("detail.id")}</dt>
          <dd>{row.id}</dd>
          <dt>{t("detail.when")}</dt>
          <dd>
            <DateText value={row.createdAt} variant="datetime" />
          </dd>
          <dt>{t("detail.actorType")}</dt>
          <dd>{type}</dd>
          <dt>{t("detail.actor")}</dt>
          <dd>{row.actorId ?? "-"}</dd>
          <dt>{t("detail.action")}</dt>
          <dd>{row.action}</dd>
          <dt>{t("detail.target")}</dt>
          <dd>
            {row.targetType === null && row.targetId === null
              ? "-"
              : `${row.targetType ?? ""} ${row.targetId ?? ""}`.trim()}
          </dd>
          <dt>{t("detail.ip")}</dt>
          <dd>{row.ip ?? "-"}</dd>
          <dt>{t("detail.userAgent")}</dt>
          <dd>{row.userAgent ?? "-"}</dd>
          <dt>{t("detail.reason")}</dt>
          <dd>{row.reason ?? t("detail.noReason")}</dd>
        </dl>
      </Card>
      <Card title={t("detail.before")}>
        <Json value={row.before} />
      </Card>
      <Card title={t("detail.after")}>
        <Json value={row.after} />
      </Card>
      <Card title={t("detail.extra")}>
        <Json value={row.extra} />
        <p className="form-text seccolor mb-0">{t("detail.masked")}</p>
      </Card>
    </>
  );
}
