import { useTranslations } from "next-intl";
import { Badge, Card, DateText, EmptyState, Field, FormBlock, SubmitButton } from "@tc/ui";
import { OPERATION_STATES, type StuckRenewalRow } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { confirmUnrenewedAction } from "../../server/ops-actions.ts";
import { mapLastError } from "../../server/ops-map.ts";
import { resultCodeOf, type ResultCode } from "./OpsViews.tsx";

// /payments/renewals (WPU-X3 b). The domain renewals stuck in needs_attention at the registry check, the last
// "registry confirmed not renewed" check of each, and the form that asks for a new one. Every error is one of the
// fixed lines of AdminOps.errors, never stored text (R14); no AWS account id, ARN or AWS message is shown. The form
// has the renewal, the id of this rendering and a reason: no field for an actor or a role.

export { resultCodeOf };

const IN_FLIGHT = ["queued", "running", "waiting"];

function ShortId({ id }: { id: string }) {
  return <span title={id}>#{id.slice(0, 8)}</span>;
}

function ErrorText({ code }: { code: string | null }) {
  const t = useTranslations("AdminOps.errors");
  const mapped = mapLastError(code);
  return <>{mapped === null ? t("none") : t(mapped as never)}</>;
}

function ResultLine({ result }: { result: ResultCode | null }) {
  const t = useTranslations("AdminRenewals.result");
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

export interface RenewalsViewProps {
  locale: Locale;
  rows: StuckRenewalRow[];
  // The id of this rendering of the forms: submitting the same form twice is one operation (R7).
  requestId: string;
  result: ResultCode | null;
}

export function RenewalsView({ locale, rows, requestId, result }: RenewalsViewProps) {
  const t = useTranslations("AdminRenewals");
  const states = useTranslations("AdminOps.state");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p>
        <a href={localePath(locale, "/payments")}>{t("back")}</a>
      </p>
      <p>{t("intro")}</p>
      <p className="form-text seccolor">{t("effect")}</p>
      <ResultLine result={result} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        rows.map((row) => {
          const check = row.lastCheck;
          const running = check !== null && IN_FLIGHT.includes(check.state);
          return (
            <Card key={row.id} title={row.domainName ?? t("table.unknownName")}>
              <dl>
                <dt>{t("table.operation")}</dt>
                <dd>
                  <ShortId id={row.id} />
                </dd>
                <dt>{t("table.attempts")}</dt>
                <dd>{row.attempts}</dd>
                <dt>{t("table.error")}</dt>
                <dd>
                  <ErrorText code={row.lastError} />
                </dd>
                <dt>{t("table.created")}</dt>
                <dd>
                  <DateText value={row.createdAt} variant="datetime" />
                </dd>
                <dt>{t("table.lastCheck")}</dt>
                <dd>
                  {check === null ? (
                    t("table.noCheck")
                  ) : (
                    <>
                      <Badge tone={check.state === "needs_attention" ? "dark" : "grey"}>
                        {(OPERATION_STATES as readonly string[]).includes(check.state)
                          ? states(check.state as never)
                          : check.state}
                      </Badge>{" "}
                      <ErrorText code={check.lastError} />{" "}
                      <DateText value={check.createdAt} variant="datetime" />
                    </>
                  )}
                </dd>
              </dl>
              {running ? (
                <p className="mb-0">{t("form.pending")}</p>
              ) : (
                <form action={confirmUnrenewedAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="requestId" value={requestId} />
                  <FormBlock>
                    <Field
                      name="reason"
                      id={`reason-unrenewed-${row.id}`}
                      label={t("form.reasonLabel")}
                      hint={t("form.reasonHint")}
                      required
                      maxLength={500}
                      autoComplete="off"
                    />
                  </FormBlock>
                  <SubmitButton variant="primary" size="sm">
                    {t("form.submit")}
                  </SubmitButton>
                </form>
              )}
            </Card>
          );
        })
      )}
    </>
  );
}
