import { useTranslations } from "next-intl";
import {
  Badge,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import { planApplyInFlight, readPlanChange, readPlanFailure } from "@tc/core";
import { OPERATION_KINDS, OPERATION_STATES, type PlanChangeView } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { clearPlanChangeMarkAction } from "../../server/ops-actions.ts";
import { mapLastError } from "../../server/ops-map.ts";
import { resultCodeOf, type ResultCode } from "./OpsViews.tsx";

// /operations/resources/[id] (WPA-P2). The plan change of a container service or a CDN as an admin sees
// it. Nothing here shows an AWS account id, an ARN or the stored text of an error: the failure code is
// one of the fixed lines of AdminOps.errors (R14). The only action is the audited clear of the failure
// mark; there is no field for an actor or a role.

export { resultCodeOf };

const RESOURCE_STATES = ["creating", "active", "stopped", "suspended", "destroyed", "failed"];

function ShortId({ id }: { id: string }) {
  return <span title={id}>#{id.slice(0, 8)}</span>;
}

function ResultLine({ result }: { result: ResultCode | null }) {
  const t = useTranslations("AdminPlanChange.result");
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

function ErrorText({ code }: { code: string | null }) {
  const t = useTranslations("AdminOps.errors");
  const mapped = mapLastError(code);
  return <>{mapped === null ? t("none") : t(mapped as never)}</>;
}

function PlanLine({ plan, productId }: { plan: PlanChangeView; productId: string | null }) {
  const t = useTranslations("AdminPlanChange.plans");
  if (productId === null) return null;
  const found = plan.plans.find((p) => p.productId === productId);
  if (found === undefined) return <>{t("unreadable")}</>;
  return (
    <>
      <code>{found.awsId}</code> {found.active ? null : <Badge tone="grey">{t("offSale")}</Badge>}
    </>
  );
}

export interface PlanChangeViewProps {
  locale: Locale;
  plan: PlanChangeView;
  // The id of this rendering of the form: submitting the same form twice is one operation (R7).
  requestId: string;
  result: ResultCode | null;
}

export function PlanChangeDetailView({ locale, plan, requestId, result }: PlanChangeViewProps) {
  const t = useTranslations("AdminPlanChange");
  const kinds = useTranslations("AdminOps.kind");
  const states = useTranslations("AdminOps.state");
  const { applied, pending } = readPlanChange(plan.config);
  const failure = readPlanFailure(plan.config);
  const inFlight = planApplyInFlight(plan.operations);
  const clearQueued = plan.operations.some(
    (o) => o.kind === "clear_plan_change_mark" && (o.state === "queued" || o.state === "running"),
  );
  const columns: DataTableColumn<PlanChangeView["operations"][number]>[] = [
    {
      key: "kind",
      header: t("operations.kind"),
      cell: (o) =>
        (OPERATION_KINDS as readonly string[]).includes(o.kind) ? kinds(o.kind as never) : o.kind,
    },
    {
      key: "state",
      header: t("operations.state"),
      cell: (o) => (
        <Badge tone={o.state === "needs_attention" ? "dark" : "grey"}>
          {(OPERATION_STATES as readonly string[]).includes(o.state)
            ? states(o.state as never)
            : o.state}
        </Badge>
      ),
    },
    {
      key: "error",
      header: t("operations.error"),
      cell: (o) => <ErrorText code={o.lastError} />,
    },
    {
      key: "created",
      header: t("operations.created"),
      cell: (o) => <DateText value={o.createdAt} variant="datetime" />,
    },
    {
      key: "open",
      header: t("operations.open"),
      cell: (o) => <a href={localePath(locale, `/operations/${o.id}`)}>{t("operations.view")}</a>,
    },
  ];
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p>
        <a href={localePath(locale, "/operations")}>{t("back")}</a>
      </p>
      <p className="form-text seccolor">{t("intro")}</p>
      <ResultLine result={result} />
      <Card title={t("facts.title")}>
        <dl className="mb-0">
          <dt>{t("facts.resource")}</dt>
          <dd>
            <ShortId id={plan.resourceId} />
          </dd>
          <dt>{t("facts.family")}</dt>
          <dd>
            {plan.family === "container_service" || plan.family === "cdn"
              ? t(`families.${plan.family}`)
              : plan.family}
          </dd>
          <dt>{t("facts.state")}</dt>
          <dd>
            {RESOURCE_STATES.includes(plan.state) ? t(`states.${plan.state}` as never) : plan.state}
          </dd>
          <dt>{t("facts.region")}</dt>
          <dd>{plan.region ?? "-"}</dd>
        </dl>
      </Card>
      <Card title={t("plans.title")}>
        <dl className="mb-0">
          <dt>{t("plans.applied")}</dt>
          <dd>
            {applied === null ? (
              t("plans.appliedNone")
            ) : (
              <PlanLine plan={plan} productId={applied} />
            )}
          </dd>
          <dt>{t("plans.pending")}</dt>
          <dd>
            {pending === null ? (
              t("plans.pendingNone")
            ) : (
              <PlanLine plan={plan} productId={pending} />
            )}
          </dd>
        </dl>
        <p className="form-text seccolor mb-0">{t("plans.renewalNote")}</p>
      </Card>
      {inFlight ? (
        <Card title={t("inFlight.title")}>
          <p className="mb-0">
            <i className="fas fa-info-circle me-1" aria-hidden="true" />
            {t("inFlight.body")}
          </p>
        </Card>
      ) : null}
      {failure === null ? (
        <EmptyState title={t("noMark.title")} description={t("noMark.body")} />
      ) : (
        <>
          <Card title={t("failed.title")}>
            <p>
              <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
              {t("failed.body")}
            </p>
            <dl className="mb-0">
              <dt>{t("failed.code")}</dt>
              <dd>
                <ErrorText code={failure.code} />
              </dd>
              <dt>{t("failed.product")}</dt>
              <dd>
                {failure.productId === null ? (
                  t("failed.productUnknown")
                ) : (
                  <PlanLine plan={plan} productId={failure.productId} />
                )}
              </dd>
              <dt>{t("failed.period")}</dt>
              <dd>
                {failure.period === null || Number.isNaN(Date.parse(failure.period)) ? (
                  t("failed.periodUnknown")
                ) : (
                  <DateText value={new Date(failure.period)} variant="datetime" />
                )}
              </dd>
            </dl>
          </Card>
          <Card title={t("clear.title")}>
            <p>{t("clear.intro")}</p>
            <p className="form-text seccolor">{t("clear.effect")}</p>
            {clearQueued ? (
              <p>{t("clear.pendingClear")}</p>
            ) : (
              <form action={clearPlanChangeMarkAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="resourceId" value={plan.resourceId} />
                <input type="hidden" name="requestId" value={requestId} />
                <FormBlock>
                  <Field
                    name="reason"
                    id={`reason-clear-${plan.resourceId}`}
                    label={t("clear.reasonLabel")}
                    hint={t("clear.reasonHint")}
                    required
                    maxLength={500}
                    autoComplete="off"
                  />
                </FormBlock>
                <SubmitButton variant="primary" size="sm">
                  {t("clear.submit")}
                </SubmitButton>
              </form>
            )}
          </Card>
        </>
      )}
      <Card title={t("operations.title")}>
        {plan.operations.length === 0 ? (
          <p className="mb-0">{t("operations.empty")}</p>
        ) : (
          <DataTable
            caption={t("operations.caption")}
            columns={columns}
            rows={plan.operations}
            rowKey={(o) => o.id}
          />
        )}
      </Card>
    </>
  );
}
