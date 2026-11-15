"use client";

import { DataTable, Field, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import type {
  CertificateFacts,
  DatabaseConsole,
  LoadBalancerConsole,
} from "../../../../server/console-view.ts";
import { FreshSignInLink } from "../_family/FreshSignInLink.tsx";

// The console forms of the detail pages (WPU-G7, U8: a button is inert while its action runs, U11:
// a result is a text, never a color alone). Every form carries the id of the resource and the request
// id that the page made (R7). The server checks everything again (R9); these forms only ask.

export type ConsoleAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The result line of an action: a fixed text for the key the server answered with (U6). */
export function ConsoleNotice({ state }: { state: FormState }) {
  const t = useTranslations("Console");
  const router = useRouter();
  useEffect(() => {
    // The page shows the new state after a success.
    if (state.done !== undefined) router.refresh();
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
        <FreshSignInLink error={state.error} />
      </div>
    );
  }
  if (state.done !== undefined) {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {t.has(`done.${state.done}`) ? t(`done.${state.done}`) : t("done.settingsQueued")}
      </div>
    );
  }
  return null;
}

export function Hidden({
  idField,
  id,
  requestId,
}: {
  idField: string;
  id: string;
  requestId: string;
}) {
  return (
    <>
      <input type="hidden" name={idField} value={id} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
}

export function fieldError(
  state: FormState,
  name: string,
  text: string,
): { error: string } | object {
  return state.fields?.[name] !== undefined ? { error: text } : {};
}

export function Choice({
  name,
  label,
  hint,
  options,
  error,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  error?: string;
  defaultValue?: string;
}) {
  const id = useId();
  return (
    <div className="mb-3">
      <label className="seccolor" htmlFor={id}>
        {label}
      </label>
      <select
        className="form-select"
        id={id}
        name={name}
        defaultValue={defaultValue ?? options[0]?.value}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint !== undefined ? (
        <p className="seccolor small mb-0" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="tc-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Health check path and HTTPS redirect of a load balancer. */
export function LoadBalancerSettingsForm({
  action,
  loadBalancerId,
  requestId,
  console: facts,
}: {
  action: ConsoleAction;
  loadBalancerId: string;
  requestId: string;
  console: LoadBalancerConsole;
}) {
  const t = useTranslations("Console.lb.settings");
  const tc = useTranslations("Console");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const invalid = tc("field.invalid");
  const redirectNow =
    facts.httpsRedirect === null
      ? t("stateUnknown")
      : facts.httpsRedirect
        ? t("stateOn")
        : t("stateOff");
  return (
    <form action={formAction} noValidate>
      <Hidden idField="loadBalancerId" id={loadBalancerId} requestId={requestId} />
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <ConsoleNotice state={state} />
      <Field
        name="healthCheckPath"
        label={t("path")}
        hint={t("pathHint", { current: facts.healthCheckPath ?? "/" })}
        maxLength={100}
        autoComplete="off"
        optional
        {...fieldError(state, "healthCheckPath", invalid)}
      />
      <Choice
        name="httpsRedirect"
        label={t("redirect")}
        hint={t("redirectHint", { current: redirectNow })}
        options={[
          { value: "", label: t("keep") },
          { value: "on", label: t("on") },
          { value: "off", label: t("off") },
        ]}
        {...(state.fields?.["httpsRedirect"] !== undefined ? { error: invalid } : {})}
      />
      <SubmitButton variant="primary">{t("button")}</SubmitButton>
    </form>
  );
}

function CertificateRecords({ certificate }: { certificate: CertificateFacts }) {
  const t = useTranslations("Console.lb.cert");
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

/** Request a certificate for a domain, show its validation records, check and attach it. */
export function LoadBalancerCertificate({
  requestAction,
  refreshAction,
  loadBalancerId,
  requestId,
  certificate,
}: {
  requestAction: ConsoleAction;
  refreshAction: ConsoleAction;
  loadBalancerId: string;
  requestId: string;
  certificate: CertificateFacts | null;
}) {
  const t = useTranslations("Console.lb.cert");
  const tc = useTranslations("Console");
  const [requestState, requestForm] = useActionState(requestAction, INITIAL_FORM_STATE);
  const [refreshState, refreshForm] = useActionState(refreshAction, INITIAL_FORM_STATE);
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      {certificate === null ? (
        <p className="seccolor">{t("none")}</p>
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
            <Hidden idField="loadBalancerId" id={loadBalancerId} requestId={requestId} />
            <ConsoleNotice state={refreshState} />
            <SubmitButton variant="default" icon="fas fa-sync">
              {t("refresh")}
            </SubmitButton>
          </form>
        </>
      )}
      {certificate === null ? (
        <form action={requestForm} noValidate>
          <Hidden idField="loadBalancerId" id={loadBalancerId} requestId={requestId} />
          <ConsoleNotice state={requestState} />
          <Field
            name="domain"
            label={t("domain")}
            hint={t("domainHint")}
            maxLength={253}
            autoComplete="off"
            required
            {...fieldError(requestState, "domain", tc("field.invalid"))}
          />
          <SubmitButton variant="primary">{t("request")}</SubmitButton>
        </form>
      ) : null}
    </>
  );
}

/** Backup window and public access of a database. */
export function DatabaseOptionsForm({
  action,
  databaseId,
  requestId,
  console: facts,
}: {
  action: ConsoleAction;
  databaseId: string;
  requestId: string;
  console: DatabaseConsole;
}) {
  const t = useTranslations("Console.db");
  const tc = useTranslations("Console");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const invalid = tc("field.invalid");
  return (
    <form action={formAction} noValidate>
      <Hidden idField="databaseId" id={databaseId} requestId={requestId} />
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <ConsoleNotice state={state} />
      <Field
        name="backupWindow"
        label={t("window")}
        hint={t("windowHint", { current: facts.backupWindow ?? t("windowNone") })}
        maxLength={11}
        autoComplete="off"
        optional
        {...fieldError(state, "backupWindow", invalid)}
      />
      <Field
        name="maintenanceWindow"
        label={t("maintenance")}
        hint={t("maintenanceHint", { current: facts.maintenanceWindow ?? t("windowNone") })}
        maxLength={23}
        autoComplete="off"
        optional
        {...fieldError(state, "maintenanceWindow", invalid)}
      />
      <Choice
        name="publicMode"
        label={t("publicMode")}
        hint={t("current", { current: facts.publiclyAccessible ? t("stateOn") : t("stateOff") })}
        options={[
          { value: "", label: t("keep") },
          { value: "on", label: t("on") },
          { value: "off", label: t("off") },
        ]}
        {...(state.fields?.["publicMode"] !== undefined ? { error: invalid } : {})}
      />
      <div className="form-check mb-3">
        <input
          className="form-check-input"
          type="checkbox"
          name="acknowledge"
          value="yes"
          id="db-ack"
        />
        <label className="form-check-label" htmlFor="db-ack">
          {t("acknowledge")}
        </label>
        <p className="seccolor small mb-0">{t("warning")}</p>
        {state.fields?.["acknowledge"] !== undefined ? (
          <p className="tc-field-error" role="alert">
            {invalid}
          </p>
        ) : null}
      </div>
      <SubmitButton variant="primary">{t("button")}</SubmitButton>
    </form>
  );
}

/** Versioning of a bucket: two buttons, one request each. */
export function BucketVersioningForm({
  action,
  bucketId,
  requestId,
  suspendRequestId,
  versioning,
}: {
  action: ConsoleAction;
  bucketId: string;
  requestId: string;
  /** A second id for the second form of the page, so that the two requests never share a key (R7). */
  suspendRequestId: string;
  versioning: "Enabled" | "Suspended" | null;
}) {
  const t = useTranslations("Console.bucket");
  const [enableState, enableForm] = useActionState(action, INITIAL_FORM_STATE);
  const [suspendState, suspendForm] = useActionState(action, INITIAL_FORM_STATE);
  const now =
    versioning === "Enabled"
      ? t("enabled")
      : versioning === "Suspended"
        ? t("suspended")
        : t("unknown");
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <p className="seccolor">{t("state", { current: now })}</p>
      <ConsoleNotice state={enableState} />
      <ConsoleNotice state={suspendState} />
      <div className="d-flex flex-wrap gap-2">
        <form action={enableForm} noValidate>
          <Hidden idField="bucketId" id={bucketId} requestId={requestId} />
          <input type="hidden" name="versioning" value="Enabled" />
          <SubmitButton variant="primary" disabled={versioning === "Enabled"}>
            {t("enable")}
          </SubmitButton>
        </form>
        <form action={suspendForm} noValidate>
          <Hidden idField="bucketId" id={bucketId} requestId={suspendRequestId} />
          <input type="hidden" name="versioning" value="Suspended" />
          <SubmitButton variant="default" disabled={versioning !== "Enabled"}>
            {t("suspend")}
          </SubmitButton>
        </form>
      </div>
    </>
  );
}

/** Flush the cache of a CDN distribution. */
export function CdnResetForm({
  action,
  cdnId,
  requestId,
  allowed,
}: {
  action: ConsoleAction;
  cdnId: string;
  requestId: string;
  allowed: boolean;
}) {
  const t = useTranslations("Console.cdn");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <Hidden idField="cdnId" id={cdnId} requestId={requestId} />
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <ConsoleNotice state={state} />
      <SubmitButton variant="default" icon="fas fa-broom" disabled={!allowed}>
        {t("button")}
      </SubmitButton>
    </form>
  );
}
