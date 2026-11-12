"use client";

import { Button, ConfirmDestroy, Field, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { PlanOption } from "../../../../../server/servers-view.ts";
import { useSpecLine } from "../ServerParts.tsx";

// The forms of the server tabs Backups, Storage, Billing and Destroy (U8: field errors from the
// server's own check, a button inert while its action runs). Every form carries the request id that
// the page made (R7). The destructive buttons open the dialog of U10; the server checks the typed
// name and the fresh sign-in again.

export type ExtrasAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The result line of an action: a fixed text for the key the server answered with (U6). */
export function ActionNotice({ state }: { state: FormState }) {
  const t = useTranslations("Extras");
  const router = useRouter();
  useEffect(() => {
    // The tab shows the new state after a success.
    if (state.done !== undefined) router.refresh();
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
      </div>
    );
  }
  if (state.done !== undefined) {
    // "destroyQueued:approval": the request waits for staff (R13, until 2026-12-01).
    const [key, flag] = state.done.split(":");
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {key !== undefined && t.has(`done.${key}`) ? t(`done.${key}`) : t("done.marked")}
        {flag === "approval" ? ` ${t("approval")}` : ""}
      </div>
    );
  }
  return null;
}

export function CreateBackupForm({
  action,
  serverId,
  requestId,
  disabled,
}: {
  action: ExtrasAction;
  serverId: string;
  requestId: string;
  disabled: boolean;
}) {
  const t = useTranslations("Extras.backups.create");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <ActionNotice state={state} />
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="requestId" value={requestId} />
      <Field
        name="name"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        disabled={disabled}
        {...(state.fields?.["name"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

/**
 * 16.10 Backups: `restoreToNewServer`. The action makes the signed draft and sends the customer to the
 * review page (16.11), where the price is shown before anything is charged. The Region is the one of
 * this server (a snapshot cannot cross a Region); the server checks it again with the backup.
 */
export function RestoreForm({
  action,
  region,
  backups,
  plans,
  disabled,
}: {
  action: ExtrasAction;
  region: string;
  backups: { id: string; name: string }[];
  plans: PlanOption[];
  disabled: boolean;
}) {
  const t = useTranslations("Extras.backups.restore");
  const te = useTranslations("Extras");
  const tf = useTranslations("Flow");
  const specLine = useSpecLine();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  if (backups.length === 0 || plans.length === 0) {
    return (
      <>
        <h3 className="mergecolor h4">{t("title")}</h3>
        <p className="seccolor">{t("none")}</p>
      </>
    );
  }
  const error = state.error;
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("body")}</p>
      {error === undefined ? null : (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`)
            ? t(`error.${error}`)
            : te.has(`error.${error}`)
              ? te(`error.${error}`)
              : te("error.unavailable")}
        </div>
      )}
      <input type="hidden" name="region" value={region} />
      <div className="mb-3">
        <label className="form-label" htmlFor="restore-backup">
          {t("backup")}
        </label>
        <select
          className="form-select"
          id="restore-backup"
          name="restoreFromBackupId"
          disabled={disabled}
        >
          {backups.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="restore-plan">
          {t("plan")}
        </label>
        <select className="form-select" id="restore-plan" name="productId" disabled={disabled}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {specLine(p.specs)}
            </option>
          ))}
        </select>
        {state.fields?.["productId"] !== undefined ? (
          <div className="invalid-feedback d-block">{t("planInvalid")}</div>
        ) : null}
      </div>
      <Field
        name="displayName"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        disabled={disabled}
        {...(state.fields?.["displayName"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

export function AutoBackupForm({
  action,
  serverId,
  requestId,
  enabled,
  hour,
  disabled,
}: {
  action: ExtrasAction;
  serverId: string;
  requestId: string;
  enabled: boolean;
  hour: string | null;
  disabled: boolean;
}) {
  const t = useTranslations("Extras.backups.auto");
  const ts = useTranslations("Extras");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("body")}</p>
      <p className="seccolor">
        <b>{t("current", { state: enabled && hour !== null ? t("on", { hour }) : t("off") })}</b>
      </p>
      <ActionNotice state={state} />
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="form-check mb-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="auto-backup-enabled"
          name="enabled"
          defaultChecked={enabled}
          disabled={disabled}
        />
        <label className="form-check-label" htmlFor="auto-backup-enabled">
          {t("enabled")}
        </label>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="auto-backup-hour">
          {t("hour")}
        </label>
        <select
          className="form-select"
          id="auto-backup-hour"
          name="hour"
          defaultValue={hour ?? "03:00"}
          disabled={disabled}
        >
          {hours.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        {state.fields?.["hour"] !== undefined ? (
          <div className="invalid-feedback d-block">{ts("error.validation")}</div>
        ) : null}
      </div>
      <SubmitButton variant="primary" disabled={disabled}>
        {ts("submit")}
      </SubmitButton>
    </form>
  );
}

/** A button that confirms by typing the resource name and posts `{ idField, confirmName, requestId }`. */
export function DestroyButton({
  action,
  fields,
  resourceName,
  label,
  title,
  description,
  size = "md",
  disabled = false,
}: {
  action: ExtrasAction;
  /** The hidden values of the form, including the request id. */
  fields: Record<string, string>;
  resourceName: string;
  label: string;
  title: string;
  description: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <Button
        size={size}
        variant="destructive"
        icon="fas fa-trash-alt"
        disabled={disabled || resourceName === ""}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ActionNotice state={state} />
      {resourceName === "" ? null : (
        <ConfirmDestroy
          open={open}
          onOpenChange={setOpen}
          resourceName={resourceName}
          title={title}
          description={description}
          pending={pending}
          onConfirm={() => {
            // The dialog has checked the typed name; the server checks it again, with a fresh sign-in (U10).
            const form = new FormData();
            for (const [name, value] of Object.entries(fields)) form.set(name, value);
            form.set("confirmName", resourceName);
            startTransition(() => formAction(form));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** A small button that posts hidden fields (detach). */
export function PostButton({
  action,
  fields,
  label,
  icon,
}: {
  action: ExtrasAction;
  fields: Record<string, string>;
  label: string;
  icon: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <ActionNotice state={state} />
      <SubmitButton size="sm" variant="default" icon={icon}>
        {label}
      </SubmitButton>
    </form>
  );
}

export function AttachDiskForm({
  action,
  serverId,
  requestId,
  disks,
}: {
  action: ExtrasAction;
  serverId: string;
  requestId: string;
  disks: { id: string; name: string }[];
}) {
  const t = useTranslations("Extras.storage.attach");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const paths = "fghijklmnop".split("").map((c) => `/dev/xvd${c}`);
  if (disks.length === 0) return <p className="seccolor">{t("none")}</p>;
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <ActionNotice state={state} />
      <input type="hidden" name="serverId" value={serverId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="mb-3">
        <label className="form-label" htmlFor="attach-disk">
          {t("disk")}
        </label>
        <select className="form-select" id="attach-disk" name="diskId">
          {disks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="attach-path">
          {t("path")}
        </label>
        <select className="form-select" id="attach-path" name="diskPath" defaultValue="/dev/xvdf">
          {paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}

/** 16.10 Billing: `renewNow`. One button; the server decides whether a renewal is due and what it costs. */
export function RenewNowForm({
  action,
  serverId,
  disabled,
}: {
  action: ExtrasAction;
  serverId: string;
  disabled: boolean;
}) {
  const t = useTranslations("Extras.billing.renewNow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4 mt-4">{t("title")}</h3>
      <p className="seccolor">{t("body")}</p>
      {disabled ? <p className="seccolor">{t("notNow")}</p> : null}
      <ActionNotice state={state} />
      <input type="hidden" name="serverId" value={serverId} />
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

export function AutoRenewForm({
  action,
  serverId,
  autoRenew,
}: {
  action: ExtrasAction;
  serverId: string;
  autoRenew: boolean;
}) {
  const t = useTranslations("Extras.billing.autoRenew");
  const ts = useTranslations("Extras");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction}>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <ActionNotice state={state} />
      <input type="hidden" name="serverId" value={serverId} />
      <div className="form-check mb-2">
        <input
          className="form-check-input"
          type="checkbox"
          id="auto-renew"
          name="autoRenew"
          defaultChecked={autoRenew}
        />
        <label className="form-check-label" htmlFor="auto-renew">
          {t("label")}
        </label>
      </div>
      <p className="seccolor">{t("hint")}</p>
      <SubmitButton variant="primary">{ts("submit")}</SubmitButton>
    </form>
  );
}
