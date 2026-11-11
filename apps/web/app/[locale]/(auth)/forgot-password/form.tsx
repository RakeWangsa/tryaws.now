"use client";

import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { AuthForm } from "../_components/AuthForm.tsx";
import { requestResetAction } from "./actions.ts";

/** The one-field form of password-reset-email-prompt.tpl. */
export function ForgotForm({ locale }: { locale: Locale }) {
  const t = useTranslations("Auth");
  return (
    <AuthForm
      action={requestResetAction}
      hidden={{ locale }}
      submitLabel={t("forgot.submit")}
      afterSubmit={
        <a className="golink position-relative" href={localePath(locale, "/login")}>
          {t("forgot.back")}
        </a>
      }
    >
      {({ error, values }) => (
        <div className="row">
          <div className="col-md-10">
            <Field
              name="email"
              type="email"
              label={t("field.email")}
              icon="fas fa-envelope"
              autoComplete="username"
              inputMode="email"
              maxLength={320}
              required
              spellCheck={false}
              autoCapitalize="off"
              defaultValue={values["email"]}
              {...(error("email") !== undefined ? { error: error("email") as string } : {})}
            />
          </div>
        </div>
      )}
    </AuthForm>
  );
}
