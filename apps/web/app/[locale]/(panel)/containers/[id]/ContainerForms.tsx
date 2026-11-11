"use client";

import { Button, ConfirmDestroy, Field, OptionGroup, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";

// The forms of the container service detail page (U8: a button inert while its action runs). Every
// form carries the request id that the page made (R7). The destroy button opens the dialog of U10;
// the server checks the typed name and the fresh sign-in again. The deploy form has no field for a
// container name or a registry login: names are generated and images are public (R11).

export type ContainerAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The result line of an action: a fixed text for the key the server answered with (U6). */
export function ContainerNotice({ state }: { state: FormState }) {
  const t = useTranslations("Containers");
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
        {key !== undefined && t.has(`done.${key}`) ? t(`done.${key}`) : t("done.deployQueued")}
        {flag === "approval" ? ` ${t("done.approval")}` : ""}
      </div>
    );
  }
  return null;
}

/** deployContainers: image, one port, environment lines, the public endpoint and its health path. */
export function DeployForm({
  action,
  containerId,
  requestId,
  allowed,
}: {
  action: ContainerAction;
  containerId: string;
  requestId: string;
  /** False unless the service is on: a deployment needs a running service. */
  allowed: boolean;
}) {
  const t = useTranslations("Containers.detail.deploy");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="containerId" value={containerId} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="seccolor">{t("intro")}</p>
      <div className="alert alert-info text-start" role="note">
        <i className="fas fa-info-circle me-2" aria-hidden="true" />
        {t("publicOnly")}
      </div>
      {allowed ? null : <p className="seccolor">{t("notActive")}</p>}

      <Field
        name="image"
        label={t("image")}
        hint={t("imageHint")}
        placeholder={t("imagePlaceholder")}
        maxLength={255}
        required
        autoComplete="off"
        disabled={!allowed}
        {...(state.fields?.["image"] !== undefined ? { error: t("imageHint") } : {})}
      />
      <div className="row">
        <div className="col-md-6">
          <Field
            name="port"
            label={t("port")}
            hint={t("portHint")}
            inputMode="numeric"
            maxLength={5}
            autoComplete="off"
            disabled={!allowed}
            {...(state.fields?.["port"] !== undefined ? { error: t("portHint") } : {})}
          />
        </div>
        <div className="col-md-6">
          <OptionGroup
            kind="select"
            name="protocol"
            legend={t("protocol")}
            options={["HTTP", "HTTPS", "TCP", "UDP"].map((value) => ({ value, label: value }))}
            defaultValue="HTTP"
          />
        </div>
      </div>
      <Field
        name="environment"
        label={t("environment")}
        hint={t("environmentHint")}
        multiline
        rows={4}
        autoComplete="off"
        disabled={!allowed}
        {...(state.fields?.["environment"] !== undefined ? { error: t("environmentHint") } : {})}
      />
      <OptionGroup
        kind="checkbox"
        name="publicEndpoint"
        legend={t("publicEndpoint")}
        options={[{ value: "on", label: t("publicEndpoint"), hint: t("publicEndpointHint") }]}
      />
      <Field
        name="healthCheckPath"
        label={t("health")}
        hint={t("healthHint")}
        maxLength={200}
        optional
        autoComplete="off"
        disabled={!allowed}
        {...(state.fields?.["healthCheckPath"] !== undefined ? { error: t("healthHint") } : {})}
      />
      <ContainerNotice state={state} />
      <SubmitButton variant="primary" icon="fas fa-rocket" disabled={!allowed}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

/** destroyContainerService: the dialog asks for the name of the service (U10). */
export function DestroyPanel({
  action,
  containerId,
  requestId,
  resourceName,
  disabled,
}: {
  action: ContainerAction;
  containerId: string;
  requestId: string;
  resourceName: string;
  disabled: boolean;
}) {
  const t = useTranslations("Containers.detail.destroy");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <p className="seccolor">{t("body")}</p>
      <ContainerNotice state={state} />
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
            form.set("containerId", containerId);
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
