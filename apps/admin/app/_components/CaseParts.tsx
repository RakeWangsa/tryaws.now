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
import { localePath, type Locale } from "@tc/ui/runtime";

// What the three case screens (/support, /abuse, /reconciliation) share. Server-rendered pieces only.
export const RESULT_CODES = [
  "ok",
  "replayed",
  "queued",
  "invalid",
  "denied",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export function resultCodeOf(value: unknown): ResultCode | null {
  return typeof value === "string" && (RESULT_CODES as readonly string[]).includes(value)
    ? (value as ResultCode)
    : null;
}

export function ResultNote({ result }: { result: ResultCode | null }) {
  const t = useTranslations("AdminCases.result");
  if (result === null) return null;
  const good = result === "ok" || result === "replayed" || result === "queued";
  return (
    <p role="status" className="mb-3">
      <i
        className={good ? "fas fa-check-circle me-1" : "fas fa-exclamation-circle me-1"}
        aria-hidden="true"
      />
      {t(result)}
    </p>
  );
}

export function Unavailable() {
  const t = useTranslations("AdminCases.unavailable");
  return <EmptyState title={t("title")} description={t("body")} />;
}

export function ReasonField({ suffix }: { suffix: string }) {
  const t = useTranslations("AdminCases.reason");
  return (
    <Field
      name="reason"
      id={`reason-${suffix}`}
      label={t("label")}
      hint={t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

export function Hidden({
  locale,
  kind,
  id,
  extra,
}: {
  locale: Locale;
  kind: string;
  id: string;
  extra?: Readonly<Record<string, string>>;
}) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      {Object.entries(extra ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

// The state is a word in the badge, never a color alone (U11). `answered` is a state of a support request
// (WPU-Z5): it waits for the requester.
export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("AdminCases.status");
  const known =
    status === "open" || status === "answered" || status === "closed" || status === "resolved";
  return (
    <Badge tone={status === "open" ? "dark" : status === "answered" ? "purple" : "grey"}>
      {known ? t(status) : status}
    </Badge>
  );
}

// The states a queue can be filtered by, each a key of AdminCases.filter; "all" is always offered.
export const CASE_FILTER_STATES = ["open", "closed"] as const;
export const SUPPORT_FILTER_STATES = ["open", "answered", "closed"] as const;

export function StatusFilter({
  action,
  query,
  states = CASE_FILTER_STATES,
}: {
  action: string;
  query: { readonly status: string | null };
  states?: readonly (typeof SUPPORT_FILTER_STATES)[number][];
}) {
  const t = useTranslations("AdminCases.filter");
  return (
    <form method="get" action={action} className="mb-4">
      <FormBlock>
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="status-filter">
            {t("status")}
          </label>
          <select
            id="status-filter"
            name="status"
            className="form-control"
            defaultValue={query.status ?? "all"}
          >
            {states.map((state) => (
              <option key={state} value={state}>
                {t(state)}
              </option>
            ))}
            <option value="all">{t("all")}</option>
          </select>
        </div>
      </FormBlock>
      <Button type="submit" variant="primary" size="sm">
        {t("submit")}
      </Button>
    </form>
  );
}

export function listHref(
  locale: Locale,
  path: string,
  query: { readonly status: string | null },
  after: string | null,
): string {
  const params = new URLSearchParams();
  if (query.status === null) params.set("status", "all");
  else if (query.status !== "open") params.set("status", query.status);
  if (after !== null) params.set("after", after);
  const text = params.toString();
  return `${localePath(locale, path)}${text === "" ? "" : `?${text}`}`;
}

export interface TrailRow {
  id: string;
  action: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface TrailLabels {
  title: string;
  empty: string;
  action: string;
  by: string;
  reason: string;
  when: string;
}

// The audit rows of one case or request: action, admin, reason and time (R10).
export function TrailCard({ rows, labels }: { rows: TrailRow[]; labels: TrailLabels }) {
  const columns: DataTableColumn<TrailRow>[] = [
    { key: "action", header: labels.action, cell: (row) => row.action },
    { key: "by", header: labels.by, cell: (row) => row.actorId?.slice(0, 8) ?? "-" },
    { key: "reason", header: labels.reason, cell: (row) => row.reason ?? "-" },
    {
      key: "when",
      header: labels.when,
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
  ];
  return (
    <Card title={labels.title}>
      {rows.length === 0 ? (
        <p className="mb-0">{labels.empty}</p>
      ) : (
        <DataTable caption={labels.title} columns={columns} rows={rows} rowKey={(row) => row.id} />
      )}
    </Card>
  );
}
