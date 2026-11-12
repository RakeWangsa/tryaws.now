"use client";

import { DataTable, Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { CachePolicyFacts, CertificateFacts } from "../../../../server/console-view.ts";
import { CertificateChange } from "./CertificateChange.tsx";
import { Choice, ConsoleNotice, Hidden, fieldError } from "./ConsoleForms.tsx";
import type { ConsoleAction } from "./ConsoleForms.tsx";

// The forms of the container service and CDN detail pages (WPU-G8): plan change at the next renewal,
// custom domain with certificate, cache behaviour, origin and public endpoint. U8: a button is inert
// while its action runs. U11: a state is a text, never a color alone. Every form carries the id of the
// resource and the request id the page made (R7). The server checks everything again (R9).

export interface PlanChoice {
  id: string;
  /** The finished option text: plan name and price from the pricing engine (R4). */
  label: string;
}

/** Choose the plan of the next renewal, or cancel the planned change. Nothing is charged by this form. */
export function PlanChangeForm({
  action,
  idField,
  resourceId,
  requestId,
  cancelRequestId,
  kind,
  currentName,
  pendingText,
  renewsText,
  choices,
  hasPending,
  pendingFailed,
  state,
}: {
  action: ConsoleAction;
  idField: "containerId" | "cdnId";
  resourceId: string;
  requestId: string;
  cancelRequestId: string;
  kind: "container" | "cdn";
  currentName: string | null;
  /** "Planned for the next renewal: ..." or null when nothing is planned. */
  pendingText: string | null;
  renewsText: string | null;
  choices: PlanChoice[];
  hasPending: boolean;
  /** WPU-S3: the apply of the pending plan failed, so it is NOT scheduled (the renewal charges the plan in force). */
  pendingFailed: boolean;
  /** "ready" lets the customer choose; the others say why not. */
  state: "ready" | "unpriced" | "inactive";
}) {
  const t = useTranslations("Console.plan");
  const tc = useTranslations("Console");
  const [setState, setForm] = useActionState(action, INITIAL_FORM_STATE);
  const [cancelState, cancelForm] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{kind === "container" ? t("introContainer") : t("introCdn")}</p>
      <p className="mb-1">
        {currentName === null ? t("currentUnknown") : t("current", { name: currentName })}
      </p>
      {renewsText === null ? null : <p className="mb-1">{renewsText}</p>}
      {pendingFailed ? (
        <div className="alert alert-warning text-start" role="status">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          <b className="mergecolor">{t("failedTitle")}</b> {t("failed")}
        </div>
      ) : (
        <p className="mb-3">
          <b className="mergecolor">{pendingText ?? t("none")}</b>
        </p>
      )}

      {state === "unpriced" ? <p className="seccolor">{t("unpriced")}</p> : null}
      {state === "inactive" ? <p className="seccolor">{t("inactive")}</p> : null}
      {state === "ready" && choices.length === 0 ? (
        <p className="seccolor">{t("noPlans")}</p>
      ) : null}

      {state === "ready" && choices.length > 0 ? (
        <form action={setForm} noValidate className="mb-3">
          <Hidden idField={idField} id={resourceId} requestId={requestId} />
          <ConsoleNotice state={setState} />
          <Choice
            name="productId"
            label={t("select")}
            options={choices.map((c) => ({ value: c.id, label: c.label }))}
            {...(setState.fields?.["productId"] !== undefined
              ? {
                  error: tc(
                    setState.fields["productId"] === "failed" ? "field.failed" : "field.invalid",
                  ),
                }
              : {})}
          />
          <SubmitButton variant="primary">{t("submit")}</SubmitButton>
        </form>
      ) : null}

      {hasPending ? (
        <form action={cancelForm} noValidate>
          {/* A second request id: the two forms never share an idempotency key (R7). */}
          <Hidden idField={idField} id={resourceId} requestId={cancelRequestId} />
          <input type="hidden" name="cancel" value="yes" />
          <ConsoleNotice state={cancelState} />
          <SubmitButton variant="default">{t("cancel")}</SubmitButton>
        </form>
      ) : null}
    </>
  );
}

function CertificateRecords({ certificate }: { certificate: CertificateFacts }) {
  const t = useTranslations("Console.cert");
  if (certificate.records.length === 0) return <p className="seccolor">{t("recordsEmpty")}</p>;
  return (
    <DataTable
      caption={t("recordsCaption")}
      rows={certificate.records}
      rowKey={(row) => `${row.type}:${row.name}`}
      columns={[
        { key: "name", header: t("recordName"), cell: (row) => <code>{row.name}</code> },
        { key: "type", header: t("recordType"), cell: (row) => row.type },
        { key: "value", header: t("recordValue"), cell: (row) => <code>{row.value}</code> },
      ]}
    />
  );
}

/** Custom domain: request a certificate, show its validation records, check and attach it. */
export function CertificatePanel({
  requestAction,
  refreshAction,
  removeAction,
  replaceAction,
  idField,
  resourceId,
  requestId,
  refreshRequestId,
  removeRequestId,
  replaceRequestId,
  certificate,
  allowed,
}: {
  requestAction: ConsoleAction;
  refreshAction: ConsoleAction;
  /** WPU-G11: take the certificate off and delete it, or replace it by one for other domains. */
  removeAction: ConsoleAction;
  replaceAction: ConsoleAction;
  removeRequestId: string;
  replaceRequestId: string;
  idField: "containerId" | "cdnId";
  resourceId: string;
  requestId: string;
  /** A second id so the two forms never share a key (R7). */
  refreshRequestId: string;
  certificate: CertificateFacts | null;
  allowed: boolean;
}) {
  const t = useTranslations("Console.cert");
  const tc = useTranslations("Console");
  const [requestState, requestForm] = useActionState(requestAction, INITIAL_FORM_STATE);
  const [refreshState, refreshForm] = useActionState(refreshAction, INITIAL_FORM_STATE);
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      {certificate === null ? (
        <>
          <p className="seccolor">{t("none")}</p>
          <form action={requestForm} noValidate>
            <Hidden idField={idField} id={resourceId} requestId={requestId} />
            <ConsoleNotice state={requestState} />
            <Field
              name="domain"
              label={t("domain")}
              hint={t("domainHint")}
              maxLength={253}
              autoComplete="off"
              required
              disabled={!allowed}
              {...fieldError(requestState, "domain", tc("field.invalid"))}
            />
            <SubmitButton variant="primary" disabled={!allowed}>
              {t("request")}
            </SubmitButton>
          </form>
        </>
      ) : (
        <>
          <p className="mb-2">
            <b className="mergecolor">{certificate.domain}</b>
          </p>
          <p className="seccolor mb-2">
            {t("status")}: {t(`statusText.${certificate.status}`)} · {t("attached")}:{" "}
            {certificate.attached ? t("attachedYes") : t("attachedNo")}
          </p>
          <h4 className="mergecolor h5">{t("recordsTitle")}</h4>
          <CertificateRecords certificate={certificate} />
          <form action={refreshForm} noValidate className="mb-4">
            <Hidden idField={idField} id={resourceId} requestId={refreshRequestId} />
            <ConsoleNotice state={refreshState} />
            <SubmitButton variant="default" icon="fas fa-sync" disabled={!allowed}>
              {t("refresh")}
            </SubmitButton>
          </form>
          <CertificateChange
            removeAction={removeAction}
            replaceAction={replaceAction}
            idField={idField}
            resourceId={resourceId}
            removeRequestId={removeRequestId}
            replaceRequestId={replaceRequestId}
            domain={certificate.domain}
            allowed={allowed}
          />
        </>
      )}
    </>
  );
}

const METHODS_ALLOWED = ["GET,HEAD", "GET,HEAD,OPTIONS", "GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE"];
const METHODS_CACHED = ["GET,HEAD", "GET,HEAD,OPTIONS"];

/** Cache behaviour of a distribution: the default, the TTLs, what is forwarded, and rules by path. */
export function CacheBehaviorForm({
  action,
  cdnId,
  requestId,
  policy,
  allowed,
}: {
  action: ConsoleAction;
  cdnId: string;
  requestId: string;
  policy: CachePolicyFacts | null;
  allowed: boolean;
}) {
  const t = useTranslations("Console.cache");
  const tc = useTranslations("Console");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const invalid = tc("field.invalid");
  const err = (name: string) =>
    state.fields?.[name] !== undefined ? { error: invalid } : ({} as object);
  const yesNo = (v: boolean) => (v ? "on" : "off");
  return (
    <form action={formAction} noValidate>
      <Hidden idField="cdnId" id={cdnId} requestId={requestId} />
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <p className="seccolor">
        {policy === null
          ? t("defaultsNote")
          : t("current", {
              behavior: t(policy.defaultBehavior),
              ttl: policy.defaultTtl,
            })}
      </p>
      <ConsoleNotice state={state} />
      <Choice
        name="defaultBehavior"
        label={t("defaultBehavior")}
        options={[
          { value: "cache", label: t("cache") },
          { value: "dont-cache", label: t("dont-cache") },
        ]}
        defaultValue={policy?.defaultBehavior ?? "cache"}
        {...(state.fields?.["defaultBehavior"] !== undefined ? { error: invalid } : {})}
      />
      <div className="row">
        <div className="col-md-4">
          <Field
            name="defaultTtl"
            label={t("defaultTtl")}
            inputMode="numeric"
            maxLength={8}
            autoComplete="off"
            defaultValue={String(policy?.defaultTtl ?? 86400)}
            disabled={!allowed}
            {...err("defaultTtl")}
          />
        </div>
        <div className="col-md-4">
          <Field
            name="minTtl"
            label={t("minTtl")}
            inputMode="numeric"
            maxLength={8}
            autoComplete="off"
            defaultValue={String(policy?.minimumTtl ?? 0)}
            disabled={!allowed}
            {...err("minTtl")}
          />
        </div>
        <div className="col-md-4">
          <Field
            name="maxTtl"
            label={t("maxTtl")}
            inputMode="numeric"
            maxLength={8}
            autoComplete="off"
            defaultValue={String(policy?.maximumTtl ?? 31536000)}
            disabled={!allowed}
            {...err("maxTtl")}
          />
        </div>
      </div>
      <p className="seccolor small">{t("ttlHint")}</p>
      <Choice
        name="allowedMethods"
        label={t("allowedMethods")}
        options={METHODS_ALLOWED.map((m) => ({ value: m, label: m }))}
        defaultValue={policy?.allowedHttpMethods ?? "GET,HEAD"}
        {...(state.fields?.["allowedMethods"] !== undefined ? { error: invalid } : {})}
      />
      <Choice
        name="cachedMethods"
        label={t("cachedMethods")}
        options={METHODS_CACHED.map((m) => ({ value: m, label: m }))}
        defaultValue={policy?.cachedHttpMethods ?? "GET,HEAD"}
        {...(state.fields?.["cachedMethods"] !== undefined ? { error: invalid } : {})}
      />
      <Choice
        name="cookies"
        label={t("cookies")}
        options={[
          { value: "none", label: t("none") },
          { value: "all", label: t("all") },
        ]}
        defaultValue={policy?.cookies ?? "none"}
        {...(state.fields?.["cookies"] !== undefined ? { error: invalid } : {})}
      />
      <Choice
        name="headers"
        label={t("headers")}
        hint={t("headersHint")}
        options={[
          { value: "none", label: t("none") },
          { value: "all", label: t("all") },
        ]}
        defaultValue={policy?.headers ?? "none"}
        {...(state.fields?.["headers"] !== undefined ? { error: invalid } : {})}
      />
      <Choice
        name="queryStrings"
        label={t("queryStrings")}
        options={[
          { value: "off", label: t("off") },
          { value: "on", label: t("on") },
        ]}
        defaultValue={yesNo(policy?.queryStrings ?? false)}
        {...(state.fields?.["queryStrings"] !== undefined ? { error: invalid } : {})}
      />
      <Field
        name="paths"
        label={t("paths")}
        hint={t("pathsHint")}
        multiline
        rows={4}
        autoComplete="off"
        optional
        defaultValue={(policy?.paths ?? []).map((p) => `${p.path}=${p.behavior}`).join("\n")}
        disabled={!allowed}
        {...err("paths")}
      />
      <SubmitButton variant="primary" disabled={!allowed}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

/** Change the origin to another server, load balancer or bucket of the same customer. */
export function OriginForm({
  action,
  cdnId,
  requestId,
  currentName,
  choices,
  allowed,
}: {
  action: ConsoleAction;
  cdnId: string;
  requestId: string;
  currentName: string;
  choices: PlanChoice[];
  allowed: boolean;
}) {
  const t = useTranslations("Console.origin");
  const tc = useTranslations("Console");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <p className="mb-3">{t("current", { name: currentName })}</p>
      {choices.length === 0 ? (
        <p className="seccolor">{t("none")}</p>
      ) : (
        <form action={formAction} noValidate>
          <Hidden idField="cdnId" id={cdnId} requestId={requestId} />
          <ConsoleNotice state={state} />
          <Choice
            name="originId"
            label={t("select")}
            options={choices.map((c) => ({ value: c.id, label: c.label }))}
            {...(state.fields?.["originId"] !== undefined ? { error: tc("field.invalid") } : {})}
          />
          <SubmitButton variant="primary" disabled={!allowed}>
            {t("submit")}
          </SubmitButton>
        </form>
      )}
    </>
  );
}

/** Public endpoint of a container service: which container and port, and the health check path. */
export function EndpointForm({
  action,
  containerId,
  requestId,
  removeRequestId,
  current,
  hasDeployment,
  allowed,
}: {
  action: ConsoleAction;
  containerId: string;
  requestId: string;
  /** A second id for the remove form, so that the two requests never share a key (R7). */
  removeRequestId: string;
  current: { container: number | null; port: number | null; healthCheckPath: string | null };
  hasDeployment: boolean;
  allowed: boolean;
}) {
  const t = useTranslations("Console.endpoint");
  const tc = useTranslations("Console");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [removeState, removeForm] = useActionState(action, INITIAL_FORM_STATE);
  const invalid = tc("field.invalid");
  const err = (name: string) =>
    state.fields?.[name] !== undefined ? { error: invalid } : ({} as object);
  const open = allowed && hasDeployment;
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      {!hasDeployment ? <p className="seccolor">{t("noDeployment")}</p> : null}
      <p className="mb-3">
        {current.port === null
          ? t("currentNone")
          : t("current", { container: current.container ?? 1, port: current.port })}
      </p>
      <form action={formAction} noValidate className="mb-3">
        <Hidden idField="containerId" id={containerId} requestId={requestId} />
        <ConsoleNotice state={state} />
        <div className="row">
          <div className="col-md-6">
            <Field
              name="container"
              label={t("container")}
              hint={t("containerHint")}
              inputMode="numeric"
              maxLength={2}
              autoComplete="off"
              defaultValue={String(current.container ?? 1)}
              disabled={!open}
              {...err("container")}
            />
          </div>
          <div className="col-md-6">
            <Field
              name="port"
              label={t("port")}
              hint={t("portHint")}
              inputMode="numeric"
              maxLength={5}
              autoComplete="off"
              {...(current.port !== null ? { defaultValue: String(current.port) } : {})}
              disabled={!open}
              {...err("port")}
            />
          </div>
        </div>
        <Field
          name="healthCheckPath"
          label={t("health")}
          hint={t("healthHint")}
          maxLength={200}
          optional
          autoComplete="off"
          {...(current.healthCheckPath !== null ? { defaultValue: current.healthCheckPath } : {})}
          disabled={!open}
          {...err("healthCheckPath")}
        />
        <SubmitButton variant="primary" disabled={!open}>
          {t("submit")}
        </SubmitButton>
      </form>
      {current.port !== null ? (
        <form action={removeForm} noValidate>
          <Hidden idField="containerId" id={containerId} requestId={removeRequestId} />
          <input type="hidden" name="remove" value="yes" />
          <ConsoleNotice state={removeState} />
          <SubmitButton variant="default" disabled={!open}>
            {t("remove")}
          </SubmitButton>
        </form>
      ) : null}
    </>
  );
}
