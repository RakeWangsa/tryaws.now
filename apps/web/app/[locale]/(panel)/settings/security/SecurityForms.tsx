"use client";

import { Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { SettingsNotice, useFieldError } from "../SettingsNotice.tsx";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** The password form (U8). The fields are never given a value back, and the browser may not fill the new ones. */
export function PasswordForm({ action, signInHref }: { action: Action; signInHref: string }) {
  const t = useTranslations("Settings.security.password");
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const error = useFieldError(state);
  const changed = state.done === "changed";
  return (
    // key: a new form after a success, so that the three fields are empty again.
    <form action={formAction} noValidate key={changed ? "done" : "form"}>
      <SettingsNotice
        state={state}
        doneText={changed ? t("changed") : null}
        signInHref={signInHref}
      />
      <Field
        name="currentPassword"
        type="password"
        label={t("current")}
        required
        autoComplete="current-password"
        {...(error("currentPassword") !== undefined
          ? { error: error("currentPassword") as string }
          : {})}
      />
      <Field
        name="newPassword"
        type="password"
        label={t("new")}
        hint={t("newHint")}
        required
        autoComplete="new-password"
        {...(error("newPassword") !== undefined ? { error: error("newPassword") as string } : {})}
      />
      <Field
        name="confirmPassword"
        type="password"
        label={t("confirm")}
        required
        autoComplete="new-password"
        {...(error("confirmPassword") !== undefined
          ? { error: error("confirmPassword") as string }
          : {})}
      />
      <SubmitButton variant="primary" pending={pending}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}
