"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormBlock, SubmitButton } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { signInAction } from "../../../server/actions.ts";
import { INITIAL_SIGN_IN } from "../../../server/state.ts";

// The form posts to a Server Action (U8). The error is a fixed code mapped to a message of the locale;
// nothing from the server answer is printed (R14). The password and the code are never kept in state.
export function LoginForm({ locale }: { locale: Locale }) {
  const t = useTranslations("Admin.login");
  const [state, action] = useActionState(signInAction, INITIAL_SIGN_IN);
  return (
    <form action={action} noValidate>
      <input type="hidden" name="locale" value={locale} />
      <FormBlock>
        <h2 className="h4 mergecolor">{t("title")}</h2>
        <p className="seccolor">{t("intro")}</p>
        {state.error !== null ? (
          <p className="tc-field-error" role="alert">
            <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
            {t(`errors.${state.error}`)}
          </p>
        ) : null}
        <Field name="email" label={t("email")} type="email" autoComplete="username" required />
        <Field
          name="password"
          label={t("password")}
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          name="code"
          label={t("code")}
          hint={t("codeHint")}
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={7}
          required
        />
        <SubmitButton>{t("submit")}</SubmitButton>
      </FormBlock>
    </form>
  );
}
