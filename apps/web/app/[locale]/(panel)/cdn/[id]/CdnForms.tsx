"use client";

import { Button, ConfirmDestroy, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";

// The forms of the CDN detail page (U8: a button inert while its action runs). Every form carries
// the request id that the page made (R7). The destroy button opens the dialog of U10; the server
// checks the typed name and the fresh sign-in again.

export type CdnAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The result line of an action: a fixed text for the key the server answered with (U6). */
export function CdnNotice({ state }: { state: FormState }) {
  const t = useTranslations("Cdn");
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
        {key !== undefined && t.has(`done.${key}`) ? t(`done.${key}`) : t("done.enabled")}
        {flag === "approval" ? ` ${t("done.approval")}` : ""}
      </div>
    );
  }
  return null;
}

/** setCdnEnabled: one button that turns the distribution off, or on again. */
export function EnabledForm({
  action,
  cdnId,
  requestId,
  enabled,
  allowed,
}: {
  action: CdnAction;
  cdnId: string;
  requestId: string;
  /** True while the distribution is on. */
  enabled: boolean;
  /** False in a state where the switch is the lifecycle's (creating, suspended, failed). */
  allowed: boolean;
}) {
  const t = useTranslations("Cdn.detail.switch");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="cdnId" value={cdnId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
      <p className="seccolor">
        {allowed ? (enabled ? t("bodyOn") : t("bodyOff")) : t("unavailable")}
      </p>
      <CdnNotice state={state} />
      <SubmitButton
        variant={enabled ? "default" : "primary"}
        icon={enabled ? "fas fa-pause" : "fas fa-play"}
        disabled={!allowed}
      >
        {enabled ? t("turnOff") : t("turnOn")}
      </SubmitButton>
    </form>
  );
}

/** destroyCdn: the dialog asks for the name of the distribution (U10). */
export function DestroyPanel({
  action,
  cdnId,
  requestId,
  resourceName,
  disabled,
}: {
  action: CdnAction;
  cdnId: string;
  requestId: string;
  resourceName: string;
  disabled: boolean;
}) {
  const t = useTranslations("Cdn.detail.destroy");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <p className="seccolor">{t("body")}</p>
      <CdnNotice state={state} />
      <Button
        variant="destructive"
        icon="fas fa-trash-alt"
        disabled={disabled || resourceName === ""}
        onClick={() => setOpen(true)}
      >
        {t("button")}
      </Button>
      {resourceName === "" ? null : (
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
            form.set("cdnId", cdnId);
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
