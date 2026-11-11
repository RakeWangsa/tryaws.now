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
  ABUSE_SOURCES,
  type AbuseCaseDetail,
  type AbuseCaseRow,
  type AbuseListResult,
} from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import type { CaseQuery, Loaded } from "../../server/case-data.ts";
import { abuseAction } from "../../server/case-actions.ts";
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

const SOURCES = ABUSE_SOURCES;
const KNOWN_STATES = ["creating", "active", "stopped", "suspended", "destroyed", "failed"] as const;

function SourceText({ source }: { source: string }) {
  const t = useTranslations("AdminCases.abuse.source");
  return <>{(SOURCES as readonly string[]).includes(source) ? t(source as "internal") : source}</>;
}

function StateText({ state }: { state: string }) {
  const t = useTranslations("AdminCases.abuse.resourceState");
  return <>{(KNOWN_STATES as readonly string[]).includes(state) ? t(state as "active") : state}</>;
}

function ListTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: CaseQuery;
  result: AbuseListResult;
}) {
  const t = useTranslations("AdminCases.abuse");
  if (result.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  const columns: DataTableColumn<AbuseCaseRow>[] = [
    {
      key: "resource",
      header: t("table.resource"),
      cell: (row) => (
        <a href={localePath(locale, `/abuse/${row.id}`)}>
          {row.family} <StateText state={row.resourceState} />
        </a>
      ),
    },
    {
      key: "customer",
      header: t("table.customer"),
      cell: (row) => (
        <a href={localePath(locale, `/customers/${row.customerId}`)}>
          {row.customerName ?? t("table.noName")}
        </a>
      ),
    },
    { key: "source", header: t("table.source"), cell: (row) => <SourceText source={row.source} /> },
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
  ];
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={result.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={
        result.nextAfter === null ? null : listHref(locale, "/abuse", query, result.nextAfter)
      }
    />
  );
}

function OpenCaseCard({ locale, newCaseId }: { locale: Locale; newCaseId: string }) {
  const t = useTranslations("AdminCases.abuse");
  return (
    <Card title={t("open.title")}>
      <form action={abuseAction}>
        <Hidden locale={locale} kind="openAbuseCase" id={newCaseId} />
        <Field
          name="resourceId"
          id="open-resource"
          label={t("open.resource")}
          hint={t("open.resourceHint")}
          required
          maxLength={36}
          autoComplete="off"
        />
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="open-source">
            {t("open.source")}
          </label>
          <select id="open-source" name="source" className="form-control" defaultValue="internal">
            {SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`source.${source}`)}
              </option>
            ))}
          </select>
        </div>
        <Field
          name="notes"
          id="open-notes"
          label={t("open.notes")}
          multiline
          rows={3}
          optional
          maxLength={2000}
        />
        <ReasonField suffix="open" />
        <SubmitButton variant="primary" size="sm">
          {t("open.submit")}
        </SubmitButton>
      </form>
    </Card>
  );
}

export interface AbuseListViewProps {
  locale: Locale;
  query: CaseQuery;
  list: Loaded<AbuseListResult>;
  result: ResultCode | null;
  // The idempotency key of one "open a case" form (R7).
  newCaseId: string;
}

// 16.12 /abuse: the cases, and the form that opens one.
export function AbuseListView({ locale, query, list, result, newCaseId }: AbuseListViewProps) {
  const t = useTranslations("AdminCases.abuse");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <ResultNote result={result} />
      <OpenCaseCard locale={locale} newCaseId={newCaseId} />
      <Card>
        <StatusFilter action={localePath(locale, "/abuse")} query={query} />
      </Card>
      {list.kind === "ok" ? (
        <ListTable locale={locale} query={query} result={list.value} />
      ) : (
        <Unavailable />
      )}
    </>
  );
}

export interface AbuseDetailViewProps {
  locale: Locale;
  abuse: AbuseCaseDetail;
  result: ResultCode | null;
  // ops and superadmin may suspend a resource; support works the case.
  canSuspend: boolean;
  // The idempotency key of one "add a note" form (R7).
  newNoteId: string;
}

// 16.12 /abuse/[id].
export function AbuseDetailView({
  locale,
  abuse,
  result,
  canSuspend,
  newNoteId,
}: AbuseDetailViewProps) {
  const t = useTranslations("AdminCases.abuse");
  const open = abuse.status === "open";
  const lines = (abuse.notes ?? "").split("\n").filter((line) => line.trim() !== "");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p>
        <Button
          href={localePath(locale, "/abuse")}
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
          <dt>{t("detail.resource")}</dt>
          <dd>{abuse.resourceId}</dd>
          <dt>{t("detail.family")}</dt>
          <dd>{abuse.family}</dd>
          <dt>{t("detail.region")}</dt>
          <dd>{abuse.region ?? "-"}</dd>
          <dt>{t("detail.state")}</dt>
          <dd>
            <StateText state={abuse.resourceState} />
          </dd>
          <dt>{t("detail.customer")}</dt>
          <dd>
            <a href={localePath(locale, `/customers/${abuse.customerId}`)}>
              {abuse.customerName ?? t("table.noName")} ({t("detail.openCustomer")})
            </a>
          </dd>
          <dt>{t("detail.source")}</dt>
          <dd>
            <SourceText source={abuse.source} />
          </dd>
          <dt>{t("table.status")}</dt>
          <dd>
            <StatusBadge status={abuse.status} />
          </dd>
          <dt>{t("table.created")}</dt>
          <dd>
            <DateText value={abuse.createdAt} variant="datetime" />
          </dd>
        </dl>
      </Card>
      <Card title={t("detail.notes")}>
        {lines.length === 0 ? (
          <p className="mb-0">{t("detail.notesEmpty")}</p>
        ) : (
          <ul className="mb-0">
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </Card>
      {open ? (
        <div className="row">
          <div className="col-lg-6">
            <Card title={t("note.title")}>
              <form action={abuseAction}>
                <Hidden
                  locale={locale}
                  kind="addNote"
                  id={abuse.id}
                  extra={{ noteId: newNoteId }}
                />
                <Field
                  name="note"
                  id="note-text"
                  label={t("note.label")}
                  multiline
                  rows={3}
                  required
                  maxLength={1000}
                />
                <ReasonField suffix="note" />
                <SubmitButton variant="primary" size="sm">
                  {t("note.submit")}
                </SubmitButton>
              </form>
            </Card>
          </div>
          <div className="col-lg-6">
            <Card title={t("suspend.title")}>
              {canSuspend ? (
                <form action={abuseAction}>
                  <Hidden locale={locale} kind="suspendResource" id={abuse.id} />
                  <p className="form-text seccolor">{t("suspend.hint")}</p>
                  <ReasonField suffix="suspend" />
                  <SubmitButton variant="destructive" size="sm">
                    {t("suspend.submit")}
                  </SubmitButton>
                </form>
              ) : (
                <p className="mb-0">{t("suspend.onlyOps")}</p>
              )}
              <p className="form-text seccolor mt-3 mb-0">{t("suspend.customerHint")}</p>
            </Card>
            <Card title={t("close.title")}>
              <form action={abuseAction}>
                <Hidden locale={locale} kind="closeAbuseCase" id={abuse.id} />
                <p className="form-text seccolor">{t("close.hint")}</p>
                <ReasonField suffix="close" />
                <SubmitButton variant="secondary" size="sm">
                  {t("close.submit")}
                </SubmitButton>
              </form>
            </Card>
          </div>
        </div>
      ) : null}
      <TrailCard
        rows={abuse.audit}
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
