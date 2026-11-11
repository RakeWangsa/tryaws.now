"use client";

import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { AuthForm } from "../_components/AuthForm.tsx";
import { PasswordFields } from "../_components/PasswordFields.tsx";
import { resetPasswordAction } from "./actions.ts";

/** The new-password form: the address (prefilled), the emailed code, the new password twice. */
export function ResetForm({ locale, email }: { locale: Locale; email: string }) {
  const t = useTranslations("Auth");
  return (
    <AuthForm action={resetPasswordAction} hidden={{ locale }} submitLabel={t("reset.submit")}>
      {({ error, values }) => (
        <>
          <div className="row">
            <div className="col-md-6 position-relative">
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
                defaultValue={values["email"] ?? email}
                {...(error("email") !== undefined ? { error: error("email") as string } : {})}
              />
            </div>
            <div className="col-md-6 position-relative">
              <Field
                name="code"
                label={t("field.code")}
                icon="fas fa-key"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={16}
                required
                hint={t("hint.code")}
                {...(error("code") !== undefined ? { error: error("code") as string } : {})}
              />
            </div>
          </div>
          <PasswordFields error={error} labelKey="newPassword" />
        </>
      )}
    </AuthForm>
  );
}
