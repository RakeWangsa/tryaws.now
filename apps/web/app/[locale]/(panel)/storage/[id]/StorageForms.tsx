"use client";

import { Button, ConfirmDestroy, Field, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { PUBLIC_CONFIRMATION } from "../../../../../server/bucket-confirm.ts";

// The forms of the bucket detail page (U8: a button inert while its action runs). Every form carries
// the request id that the page made (R7). The destroy button opens the dialog of U10; the server
// checks the typed name and the fresh sign-in again. The public button needs the typed confirmation
// text; the server checks it again.

export type StorageAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The result line of an action: a fixed text for the key the server answered with (U6). */
export function StorageNotice({ state }: { state: FormState }) {
  const t = useTranslations("Storage");
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
      </div>
    );
  }
  if (state.done !== undefined) {
    // "destroyQueued:approval": the request waits for staff (R13, until 2026-12-01).
    const [key, flag] = state.done.split(":");
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {key !== undefined && t.has(`done.${key}`) ? t(`done.${key}`) : t("done.accessPrivate")}
        {flag === "approval" ? ` ${t("done.approval")}` : ""}
      </div>
    );
  }
  return null;
}

/** setBucketAccess: make private (one button) or public (a warning, the typed text, one button). */
export function AccessForms({
  action,
  bucketId,
  requestId,
  allowed,
}: {
  action: StorageAction;
  bucketId: string;
  requestId: string;
  /** False unless the bucket is on: a suspended bucket stays closed (R13). */
  allowed: boolean;
}) {
  const t = useTranslations("Storage.detail.access");
  const [privateState, privateAction] = useActionState(action, INITIAL_FORM_STATE);
  const [publicState, publicAction] = useActionState(action, INITIAL_FORM_STATE);
  const confirmError =
    publicState.error === "confirm_required" || publicState.fields?.["confirmText"] !== undefined;
  return (
    <>
      <p className="seccolor">{t("body")}</p>
      {allowed ? null : <p className="seccolor">{t("notActive")}</p>}

      <form action={privateAction} noValidate className="mb-4">
        <input type="hidden" name="bucketId" value={bucketId} />
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="mode" value="private" />
        <StorageNotice state={privateState} />
        <SubmitButton variant="default" icon="fas fa-lock" disabled={!allowed}>
          {t("makePrivate")}
        </SubmitButton>
      </form>

      <form action={publicAction} noValidate>
        <input type="hidden" name="bucketId" value={bucketId} />
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="mode" value="public" />
        <div className="alert alert-warning text-start" role="note">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t("publicWarning")}
        </div>
        <Field
          name="confirmText"
          label={t("confirmLabel", { word: PUBLIC_CONFIRMATION })}
          hint={t("confirmHint")}
          autoComplete="off"
          disabled={!allowed}
          {...(confirmError ? { error: t("confirmHint") } : {})}
        />
        <StorageNotice state={publicState} />
        <SubmitButton variant="destructive" icon="fas fa-globe" disabled={!allowed}>
          {t("publicAction")}
        </SubmitButton>
      </form>
    </>
  );
}

/** deleteAccessKey: the customer types the id of the key to delete. */
export function DeleteKeyForm({
  action,
  bucketId,
  requestId,
  allowed,
}: {
  action: StorageAction;
  bucketId: string;
  requestId: string;
  allowed: boolean;
}) {
  const t = useTranslations("Storage.detail.keys");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="bucketId" value={bucketId} />
      <input type="hidden" name="requestId" value={requestId} />
      <h3 className="mergecolor h4">{t("deleteTitle")}</h3>
      <p className="seccolor">{t("deleteBody")}</p>
      <Field
        name="accessKeyId"
        label={t("deleteField")}
        hint={t("deleteHint")}
        placeholder={t("deletePlaceholder")}
        maxLength={128}
        autoComplete="off"
        disabled={!allowed}
        {...(state.fields?.["accessKeyId"] !== undefined ? { error: t("deleteHint") } : {})}
      />
      <StorageNotice state={state} />
      <SubmitButton variant="destructive" icon="fas fa-trash-alt" disabled={!allowed}>
        {t("delete")}
      </SubmitButton>
    </form>
  );
}

/** destroyBucket: the dialog asks for the name of the bucket (U10). Closed while the guard says so. */
export function DestroyPanel({
  action,
  bucketId,
  requestId,
  resourceName,
  disabled,
  open: destroyOpen,
}: {
  action: StorageAction;
  bucketId: string;
  requestId: string;
  resourceName: string;
  disabled: boolean;
  /** What the lifecycle guard says about a destroy of this family today (R13). */
  open: boolean;
}) {
  const t = useTranslations("Storage.detail.destroy");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <p className="seccolor">{t("body")}</p>
      {destroyOpen ? null : (
        <div className="alert alert-info text-start" role="note">
          <i className="fas fa-info-circle me-2" aria-hidden="true" />
          {t("closed")}
        </div>
      )}
      <StorageNotice state={state} />
      <Button
        variant="destructive"
        icon="fas fa-trash-alt"
        disabled={disabled || !destroyOpen || resourceName === ""}
        onClick={() => setOpen(true)}
      >
        {t("button")}
      </Button>
      {resourceName === "" || !destroyOpen ? null : (
        <ConfirmDestroy
          open={open}
          onOpenChange={setOpen}
          resourceName={resourceName}
          title={t("dialogTitle")}
          description={t("dialogBody")}
          pending={pending}
          onConfirm={() => {
            // The dialog has checked the typed name; the server checks it again, with a fresh sign-in (U10).
            const form = new FormData();
            form.set("bucketId", bucketId);
            form.set("requestId", requestId);
            form.set("confirmName", resourceName);
            startTransition(() => formAction(form));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
