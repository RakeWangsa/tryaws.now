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
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import { capacityWarning, freeUnits } from "@tc/core";
import {
  OPERATION_KINDS,
  OPERATION_STATES,
  type CapacityRow,
  type OperationDetail,
  type OperationQueueRow,
  type WaitlistCount,
} from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { capacityAction } from "../../server/capacity-actions.ts";
import type { Correction } from "../../server/capacity-flow.ts";
import type { CapacityView as CapacityData, OpsQueues, OpsQuery } from "../../server/ops-data.ts";
import { operationAction } from "../../server/ops-actions.ts";
import { actionsFor, mapLastError, type OpsActionKind } from "../../server/ops-map.ts";

// 16.12 /capacity and /operations. Nothing here shows an AWS account id, an ARN or the stored text of
// an error: the pool is its generated name, the error is one of the fixed lines of `errors` (R14).

export const RESULT_CODES = [
  "ok",
  "replayed",
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

function ResultLine({
  ns,
  result,
}: {
  ns: "AdminOps" | "AdminCapacity";
  result: ResultCode | null;
}) {
  const t = useTranslations(`${ns}.result`);
  if (result === null) return null;
  return (
    <p role="status" className="mb-3">
      <i
        className={
          result === "ok" || result === "replayed"
            ? "fas fa-check-circle me-1"
            : "fas fa-exclamation-circle me-1"
        }
        aria-hidden="true"
      />
      {t(result)}
    </p>
  );
}

function ShortId({ id }: { id: string }) {
  return <span title={id}>#{id.slice(0, 8)}</span>;
}

function Select({
  id,
  name,
  label,
  options,
  value,
}: {
  id: string;
  name: string;
  label: string;
  options: { value: string; text: string }[];
  value?: string;
}) {
  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={name} className="form-control" defaultValue={value ?? ""}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReasonField({
  ns,
  suffix,
  hint,
}: {
  ns: "AdminOps" | "AdminCapacity";
  suffix: string;
  hint?: string;
}) {
  const t = useTranslations(`${ns}.reason`);
  return (
    <Field
      name="reason"
      id={`reason-${suffix}`}
      label={t("label")}
      hint={hint ?? t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function Hidden({ locale, entries }: { locale: Locale; entries: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      {Object.entries(entries).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------- operations

function StateBadge({ state }: { state: string }) {
  const t = useTranslations("AdminOps.state");
  const tone =
    state === "needs_approval"
      ? "pink"
      : state === "needs_attention"
        ? "dark"
        : state === "succeeded"
          ? "purple"
          : "grey";
  return (
    <Badge tone={tone}>
      {(OPERATION_STATES as readonly string[]).includes(state) ? t(state as never) : state}
    </Badge>
  );
}

function KindText({ kind }: { kind: string }) {
  const t = useTranslations("AdminOps.kind");
  return (
    <>{(OPERATION_KINDS as readonly string[]).includes(kind) ? t(kind as never) : t("other")}</>
  );
}

function ErrorText({ lastError }: { lastError: string | null }) {
  const t = useTranslations("AdminOps.errors");
  const code = mapLastError(lastError);
  return <>{code === null ? t("none") : t(code as never)}</>;
}

function QueueTable({
  locale,
  rows,
  caption,
  nextHref,
}: {
  locale: Locale;
  rows: OperationQueueRow[];
  caption: string;
  nextHref: string | null;
}) {
  const t = useTranslations("AdminOps.queue");
  const columns: DataTableColumn<OperationQueueRow>[] = [
    {
      key: "kind",
      header: t("columns.kind"),
      cell: (row) => (
        <>
          <KindText kind={row.kind} />{" "}
          {row.destructive ? <Badge tone="pink">{t("destructive")}</Badge> : null}
        </>
      ),
    },
    { key: "state", header: t("columns.state"), cell: (row) => <StateBadge state={row.state} /> },
    {
      key: "resource",
      header: t("columns.resource"),
      cell: (row) => (
        <>
          <ShortId id={row.resourceId} />
          {row.family === null ? "" : ` ${row.family}`}
        </>
      ),
    },
    { key: "attempts", header: t("columns.attempts"), cell: (row) => String(row.attempts) },
    {
      key: "error",
      header: t("columns.error"),
      cell: (row) => <ErrorText lastError={row.lastError} />,
    },
    {
      key: "created",
      header: t("columns.created"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "open",
      header: t("columns.open"),
      cell: (row) => <a href={localePath(locale, `/operations/${row.id}`)}>{t("open")}</a>,
    },
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={nextHref}
    />
  );
}

function FilterForm({ locale, query }: { locale: Locale; query: OpsQuery }) {
  const t = useTranslations("AdminOps");
  return (
    <form method="get" action={localePath(locale, "/operations")} className="mb-4">
      <FormBlock>
        <Select
          id="state-filter"
          name="state"
          label={t("queue.filter.state")}
          value={query.state ?? ""}
          options={[
            { value: "", text: t("queue.filter.all") },
            ...OPERATION_STATES.map((s) => ({ value: s, text: t(`state.${s}`) })),
          ]}
        />
        <Select
          id="kind-filter"
          name="kind"
          label={t("queue.filter.kind")}
          value={query.kind ?? ""}
          options={[
            { value: "", text: t("queue.filter.all") },
            ...OPERATION_KINDS.map((k) => ({ value: k, text: t(`kind.${k}`) })),
          ]}
        />
      </FormBlock>
      <Button type="submit" variant="primary" size="sm">
        {t("queue.filter.submit")}
      </Button>{" "}
      {query.state !== null || query.kind !== null ? (
        <a href={localePath(locale, "/operations")}>{t("queue.filter.clear")}</a>
      ) : null}
    </form>
  );
}

export interface OperationsViewProps {
  locale: Locale;
  query: OpsQuery;
  queues: { kind: "ok"; value: OpsQueues } | { kind: "unavailable" | "missing" | "denied" };
  result: ResultCode | null;
}

function filteredHref(locale: Locale, query: OpsQuery, after: string): string {
  const params = new URLSearchParams();
  if (query.state !== null) params.set("state", query.state);
  if (query.kind !== null) params.set("kind", query.kind);
  params.set("after", after);
  return `${localePath(locale, "/operations")}?${params.toString()}`;
}

// 16.12 /operations: the queues that need a person, the filter, and the way into each operation.
export function OperationsView({ locale, query, queues, result }: OperationsViewProps) {
  const t = useTranslations("AdminOps");
  return (
    <>
      <h2 className="h4 mergecolor">{t("queue.title")}</h2>
      <ResultLine ns="AdminOps" result={result} />
      <p className="form-text seccolor">{t("queue.intro")}</p>
      {queues.kind !== "ok" ? (
        <EmptyState title={t("queue.unavailable")} description={t("queue.unavailableBody")} />
      ) : (
        <>
          <Card title={t("queue.countsTitle")}>
            <ul className="list-unstyled mb-0">
              {OPERATION_STATES.map((s) => (
                <li key={s}>
                  <a href={`${localePath(locale, "/operations")}?state=${s}`}>{t(`state.${s}`)}</a>:{" "}
                  {queues.value.counts[s]}
                </li>
              ))}
            </ul>
          </Card>
          <Card title={t("queue.filter.title")}>
            <FilterForm locale={locale} query={query} />
          </Card>
          {queues.value.filtered !== null ? (
            <Card title={t("queue.filtered.title")}>
              {queues.value.filtered.rows.length === 0 ? (
                <p className="mb-0">{t("queue.filtered.empty")}</p>
              ) : (
                <QueueTable
                  locale={locale}
                  rows={queues.value.filtered.rows}
                  caption={t("queue.filtered.caption")}
                  nextHref={
                    queues.value.filtered.nextAfter === null
                      ? null
                      : filteredHref(locale, query, queues.value.filtered.nextAfter)
                  }
                />
              )}
            </Card>
          ) : (
            <>
              <Card title={t("queue.approval.title")}>
                {queues.value.needsApproval === null ||
                queues.value.needsApproval.rows.length === 0 ? (
                  <p className="mb-0">{t("queue.approval.empty")}</p>
                ) : (
                  <QueueTable
                    locale={locale}
                    rows={queues.value.needsApproval.rows}
                    caption={t("queue.approval.caption")}
                    nextHref={null}
                  />
                )}
              </Card>
              <Card title={t("queue.attention.title")}>
                <p className="form-text seccolor">{t("queue.attention.deadLetterNote")}</p>
                {queues.value.needsAttention === null ||
                queues.value.needsAttention.rows.length === 0 ? (
                  <p className="mb-0">{t("queue.attention.empty")}</p>
                ) : (
                  <QueueTable
                    locale={locale}
                    rows={queues.value.needsAttention.rows}
                    caption={t("queue.attention.caption")}
                    nextHref={null}
                  />
                )}
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

function ActionForm({ locale, kind, id }: { locale: Locale; kind: OpsActionKind; id: string }) {
  const t = useTranslations("AdminOps.detail");
  return (
    <form action={operationAction} className="mb-3">
      <Hidden locale={locale} entries={{ kind, id }} />
      <FormBlock>
        <ReasonField ns="AdminOps" suffix={`${kind}-${id}`} hint={t(`actionHints.${kind}`)} />
      </FormBlock>
      <SubmitButton variant={kind === "rejectOperation" ? "destructive" : "primary"} size="sm">
        {t(`actions.${kind}`)}
      </SubmitButton>
    </form>
  );
}

export interface OperationDetailViewProps {
  locale: Locale;
  operation: OperationDetail;
  result: ResultCode | null;
}

// 16.12 /operations/[id]: the facts, the decisions so far, and the actions the stored state allows now.
// There is no approver field: the approver is the signed-in admin.
export function OperationDetailView({ locale, operation, result }: OperationDetailViewProps) {
  const t = useTranslations("AdminOps.detail");
  const plan = useTranslations("AdminPlanChange");
  const actions = actionsFor(operation);
  const trailColumns: DataTableColumn<OperationDetail["trail"][number]>[] = [
    {
      key: "when",
      header: t("trail.when"),
      cell: (e) => <DateText value={e.at} variant="datetime" />,
    },
    { key: "action", header: t("trail.action"), cell: (e) => e.action },
    {
      key: "actor",
      header: t("trail.actor"),
      cell: (e) => (e.actorId === null ? "-" : <ShortId id={e.actorId} />),
    },
    { key: "reason", header: t("trail.reason"), cell: (e) => e.reason ?? "-" },
  ];
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p>
        <a href={localePath(locale, "/operations")}>{t("back")}</a>
      </p>
      <ResultLine ns="AdminOps" result={result} />
      <Card>
        <dl className="mb-0">
          <dt>{t("kind")}</dt>
          <dd>
            <KindText kind={operation.kind} />
          </dd>
          <dt>{t("state")}</dt>
          <dd>
            <StateBadge state={operation.state} />
          </dd>
          <dt>{t("destructive")}</dt>
          <dd>{operation.destructive ? t("yes") : t("no")}</dd>
          <dt>{t("resource")}</dt>
          <dd>
            <ShortId id={operation.resourceId} />
            {operation.family === "container_service" || operation.family === "cdn" ? (
              <>
                {" "}
                <a href={localePath(locale, `/operations/resources/${operation.resourceId}`)}>
                  {plan("link")}
                </a>
              </>
            ) : null}
          </dd>
          <dt>{t("family")}</dt>
          <dd>{operation.family ?? "-"}</dd>
          <dt>{t("region")}</dt>
          <dd>{operation.region ?? "-"}</dd>
          <dt>{t("step")}</dt>
          <dd>{operation.step ?? t("noStep")}</dd>
          <dt>{t("attempts")}</dt>
          <dd>{operation.attempts}</dd>
          <dt>{t("nextRun")}</dt>
          <dd>
            <DateText value={operation.nextRunAt} variant="datetime" />
          </dd>
          <dt>{t("approvedBy")}</dt>
          <dd>
            {operation.approvedBy === null ? (
              t("notApproved")
            ) : (
              <ShortId id={operation.approvedBy} />
            )}
          </dd>
          <dt>{t("lastError")}</dt>
          <dd>
            <ErrorText lastError={operation.lastError} />
          </dd>
          <dt>{t("created")}</dt>
          <dd>
            <DateText value={operation.createdAt} variant="datetime" />
          </dd>
        </dl>
      </Card>
      <Card title={t("trailTitle")}>
        {operation.trail.length === 0 ? (
          <p className="mb-0">{t("trailEmpty")}</p>
        ) : (
          <DataTable
            caption={t("trailCaption")}
            columns={trailColumns}
            rows={operation.trail}
            rowKey={(e) => `${e.at.toISOString()}-${e.action}`}
          />
        )}
      </Card>
      {actions.length === 0 ? (
        <p className="form-text seccolor">{t("noActions")}</p>
      ) : (
        <Card>
          {actions.map((kind) => (
            <ActionForm key={kind} locale={locale} kind={kind} id={operation.id} />
          ))}
        </Card>
      )}
      {operation.kind === "create" && operation.state === "needs_approval" ? (
        <p className="form-text seccolor">{t("createNote")}</p>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------ capacity

type Level = "ok" | "warning" | "full" | "over";

export function levelOf(row: Pick<CapacityRow, "limit" | "used" | "reserve">): Level {
  if (row.used > row.limit) return "over";
  if (row.limit > 0 && freeUnits(row) === 0) return "full";
  return capacityWarning(row) ? "warning" : "ok";
}

function LevelBadge({ level }: { level: Level }) {
  const t = useTranslations("AdminCapacity.level");
  const tone = level === "ok" ? "grey" : level === "warning" ? "dark" : "pink";
  return <Badge tone={tone}>{t(level)}</Badge>;
}

function cellKey(row: CapacityRow): string {
  return `${row.poolAccountId}~${row.region}~${row.quotaCode}`;
}

function PoolCard({
  locale,
  rows,
  canAct,
}: {
  locale: Locale;
  rows: CapacityRow[];
  canAct: boolean;
}) {
  const t = useTranslations("AdminCapacity");
  const first = rows[0];
  if (first === undefined) return null;
  const columns: DataTableColumn<CapacityRow>[] = [
    { key: "region", header: t("columns.region"), cell: (r) => r.region },
    { key: "quota", header: t("columns.quota"), cell: (r) => t(`quota.${r.quotaCode}`) },
    { key: "used", header: t("columns.used"), cell: (r) => `${r.used} / ${r.limit}` },
    { key: "reserve", header: t("columns.reserve"), cell: (r) => String(r.reserve) },
    { key: "level", header: t("columns.level"), cell: (r) => <LevelBadge level={levelOf(r)} /> },
    {
      key: "checked",
      header: t("columns.checked"),
      cell: (r) =>
        r.checkedAt === null ? t("never") : <DateText value={r.checkedAt} variant="datetime" />,
    },
    {
      key: "recompute",
      header: t("columns.recompute"),
      cell: (r) => (
        <a href={`${localePath(locale, "/capacity")}?cell=${cellKey(r)}#recompute`}>
          {t("recompute.link")}
        </a>
      ),
    },
  ];
  if (canAct) {
    columns.push({
      key: "edit",
      header: t("columns.edit"),
      cell: (r) => (
        <form action={capacityAction}>
          <Hidden
            locale={locale}
            entries={{
              kind: "setCapacityLimit",
              poolAccountId: r.poolAccountId,
              region: r.region,
              quotaCode: r.quotaCode,
            }}
          />
          <FormBlock>
            <Field
              name="limit"
              id={`limit-${cellKey(r)}`}
              label={t("edit.limit")}
              hint={t("edit.hint")}
              required
              inputMode="numeric"
              maxLength={7}
              defaultValue={String(r.limit)}
              autoComplete="off"
            />
            <ReasonField ns="AdminCapacity" suffix={cellKey(r)} />
          </FormBlock>
          <SubmitButton variant="primary" size="sm">
            {t("edit.submit")}
          </SubmitButton>
        </form>
      ),
    });
  }
  const tier = first.tier === "trusted" ? t("pool.tier.trusted") : t("pool.tier.new");
  const status = first.status === "disabled" ? t("pool.status.disabled") : t("pool.status.active");
  return (
    <Card title={first.poolName}>
      <p>
        <Badge tone="grey">{tier}</Badge>{" "}
        <Badge tone={first.status === "active" ? "purple" : "pink"}>{status}</Badge>
      </p>
      <DataTable
        caption={t("pool.caption")}
        columns={columns}
        rows={rows}
        rowKey={(r) => cellKey(r)}
      />
    </Card>
  );
}

function RecomputeCard({
  locale,
  row,
  live,
  correction,
}: {
  locale: Locale;
  row: CapacityRow;
  live: string;
  correction: Correction | null;
}) {
  const t = useTranslations("AdminCapacity.recompute");
  const q = useTranslations("AdminCapacity.quota");
  const delta =
    correction === null
      ? ""
      : correction.delta > 0
        ? `+${correction.delta}`
        : String(correction.delta);
  return (
    <Card title={t("title")}>
      <div id="recompute">
        <p>{t("intro")}</p>
        <p>
          {t("cell")}: {row.poolName} / {row.region} / {q(row.quotaCode)}
        </p>
        <form method="get" action={localePath(locale, "/capacity")}>
          <input type="hidden" name="cell" value={cellKey(row)} />
          <FormBlock>
            <Field
              name="live"
              id="recompute-live"
              label={t("live")}
              required
              inputMode="numeric"
              maxLength={7}
              defaultValue={live}
              autoComplete="off"
            />
          </FormBlock>
          <Button type="submit" variant="primary" size="sm">
            {t("submit")}
          </Button>{" "}
          <a href={localePath(locale, "/capacity")}>{t("close")}</a>
        </form>
        {correction === null ? (
          <p className="form-text seccolor">{t("none")}</p>
        ) : (
          <ul className="list-unstyled mb-0 mt-3">
            <li>
              {t("before")}: {correction.used}
            </li>
            <li>
              {t("pending")}: {correction.pending}
            </li>
            <li>
              {t("after")}: {correction.corrected}
            </li>
            <li>
              {t("delta")}: {delta}
            </li>
          </ul>
        )}
      </div>
    </Card>
  );
}

function WaitlistCard({
  locale,
  rows,
  canAct,
}: {
  locale: Locale;
  rows: WaitlistCount[];
  canAct: boolean;
}) {
  const t = useTranslations("AdminCapacity.waitlist");
  const columns: DataTableColumn<WaitlistCount>[] = [
    { key: "family", header: t("columns.family"), cell: (r) => r.productFamily },
    { key: "region", header: t("columns.region"), cell: (r) => r.region },
    { key: "reason", header: t("columns.reason"), cell: (r) => t(`reasons.${r.reason}`) },
    { key: "open", header: t("columns.open"), cell: (r) => String(r.open) },
  ];
  if (canAct) {
    columns.push({
      key: "notify",
      header: t("columns.notify"),
      cell: (r) => (
        <form action={capacityAction}>
          <Hidden
            locale={locale}
            entries={{
              kind: "notifyWaitlist",
              productFamily: r.productFamily,
              region: r.region,
              waitlistReason: r.reason,
            }}
          />
          <FormBlock>
            <Field
              name="count"
              id={`count-${r.productFamily}-${r.region}-${r.reason}`}
              label={t("count")}
              hint={t("hint")}
              required
              inputMode="numeric"
              maxLength={3}
              defaultValue="1"
              autoComplete="off"
            />
            <ReasonField
              ns="AdminCapacity"
              suffix={`wl-${r.productFamily}-${r.region}-${r.reason}`}
            />
          </FormBlock>
          <SubmitButton variant="primary" size="sm">
            {t("submit")}
          </SubmitButton>
        </form>
      ),
    });
  }
  return (
    <Card title={t("title")}>
      {rows.length === 0 ? (
        <p className="mb-0">{t("empty")}</p>
      ) : (
        <DataTable
          caption={t("caption")}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.productFamily}-${r.region}-${r.reason}`}
        />
      )}
    </Card>
  );
}

export interface CapacityViewProps {
  locale: Locale;
  data: { kind: "ok"; value: CapacityData } | { kind: "unavailable" | "missing" | "denied" };
  canAct: boolean;
  recompute: { cell: string; live: string } | null;
  result: ResultCode | null;
}

// 16.12 /capacity: pool accounts with used against limit and the warning level, the limit edit, the
// recompute preview with the correction, and the waitlist.
export function CapacityPageView({ locale, data, canAct, recompute, result }: CapacityViewProps) {
  const t = useTranslations("AdminCapacity");
  if (data.kind !== "ok") {
    return (
      <>
        <h2 className="h4 mergecolor">{t("title")}</h2>
        <EmptyState title={t("unavailable")} description={t("unavailableBody")} />
      </>
    );
  }
  const pools = new Map<string, CapacityRow[]>();
  for (const row of data.value.rows) {
    pools.set(row.poolAccountId, [...(pools.get(row.poolAccountId) ?? []), row]);
  }
  const target =
    recompute === null ? undefined : data.value.rows.find((r) => cellKey(r) === recompute.cell);
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <ResultLine ns="AdminCapacity" result={result} />
      <p className="form-text seccolor">{t("intro")}</p>
      {pools.size === 0 ? <p>{t("empty")}</p> : null}
      {[...pools.entries()].map(([id, rows]) => (
        <PoolCard key={id} locale={locale} rows={rows} canAct={canAct} />
      ))}
      {target !== undefined && recompute !== null ? (
        <RecomputeCard
          locale={locale}
          row={target}
          live={recompute.live}
          correction={data.value.correction}
        />
      ) : null}
      <WaitlistCard locale={locale} rows={data.value.waitlist} canAct={canAct} />
    </>
  );
}
