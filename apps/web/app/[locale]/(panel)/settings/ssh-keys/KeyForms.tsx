"use client";

import { Button, ConfirmDestroy, Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { FreshSignInLink } from "../../_family/FreshSignInLink.tsx";

// The two forms of /settings/ssh-keys (U8: field errors from the server's own check, a button that is
// inert while its action runs). Only public keys are posted; a private key is refused by the server and
// never echoed back.

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

function Notice({ state, doneKey }: { state: FormState; doneKey: string }) {
  const tf = useTranslations("Flow");
  const t = useTranslations("SshKeys");
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {tf.has(`error.${state.error}`) ? tf(`error.${state.error}`) : tf("error.unavailable")}
        <FreshSignInLink error={state.error} />
      </div>
    );
  }
  if (state.done !== undefined) {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {state.done === "replayed" ? t("add.replayed") : t(doneKey)}
      </div>
    );
  }
  return null;
}

export function AddKeyForm({ action }: { action: Action }) {
  const t = useTranslations("SshKeys.add");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  return (
    <form action={formAction} noValidate>
      <Notice state={state} doneKey="add.done" />
      <Field
        name="name"
        label={t("name")}
        hint={t("nameHint")}
        maxLength={60}
        required
        autoComplete="off"
        {...(fieldError("name") !== undefined ? { error: fieldError("name") as string } : {})}
      />
      <Field
        name="publicKey"
        label={t("publicKey")}
        hint={t("publicKeyHint")}
        multiline
        rows={4}
        required
        autoComplete="off"
        spellCheck={false}
        {...(fieldError("publicKey") !== undefined
          ? { error: fieldError("publicKey") as string }
          : {})}
      />
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}

export function RemoveKeyButton({
  action,
  keyId,
  keyName,
}: {
  action: Action;
  keyId: string;
  keyName: string;
}) {
  const t = useTranslations("SshKeys");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <>
      <Button size="sm" variant="tertiary" icon="fas fa-trash-alt" onClick={() => setOpen(true)}>
        {t("list.remove")}
      </Button>
      <Notice state={state} doneKey="confirm.removed" />
      <ConfirmDestroy
        open={open}
        onOpenChange={setOpen}
        resourceName={keyName}
        title={t("confirm.title")}
        description={t("confirm.description")}
        pending={pending}
        onConfirm={() => {
          // The dialog has checked the typed name; the server checks it again, with a fresh sign-in (U10).
          const form = new FormData();
          form.set("id", keyId);
          form.set("confirmName", keyName);
          startTransition(() => formAction(form));
          setOpen(false);
        }}
      />
    </>
  );
}
