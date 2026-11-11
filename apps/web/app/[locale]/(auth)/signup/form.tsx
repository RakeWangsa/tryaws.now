"use client";

import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { AuthForm } from "../_components/AuthForm.tsx";
import { ConsentBoxes } from "../_components/ConsentBoxes.tsx";
import { PasswordFields } from "../_components/PasswordFields.tsx";
import { signUpAction } from "./actions.ts";

/**
 * The "Create a New Account" form of login.html, for an individual (the business option and the
 * company name are deferred): personal information, account security, the three consents.
 */
export function SignUpForm({ locale, next }: { locale: Locale; next: string }) {
  const t = useTranslations("Auth");
  return (
    <AuthForm
      action={signUpAction}
      hidden={{ locale, ...(next !== "" ? { next } : {}) }}
      submitLabel={t("signup.submit")}
    >
      {({ error, values }) => (
        <>
          <div className="seccolor">
            <small>{t("signup.personal")}</small>
          </div>
          <div className="row mb-5">
            <div className="col-md-6 position-relative">
              <Field
                name="fullName"
                label={t("field.fullName")}
                icon="fas fa-user-tie"
                autoComplete="name"
                maxLength={200}
                required
                defaultValue={values["fullName"]}
                {...(error("fullName") !== undefined ? { error: error("fullName") as string } : {})}
              />
            </div>
            <div className="col-md-6 position-relative">
              <Field
                name="email"
                type="email"
                label={t("field.email")}
                icon="fas fa-envelope"
                autoComplete="email"
                inputMode="email"
                maxLength={320}
                required
                spellCheck={false}
                autoCapitalize="off"
                defaultValue={values["email"]}
                {...(error("email") !== undefined ? { error: error("email") as string } : {})}
              />
            </div>
            <div className="col-md-6 position-relative">
              <Field
                name="phone"
                type="tel"
                label={t("field.phone")}
                icon="fas fa-phone"
                autoComplete="tel"
                inputMode="tel"
                maxLength={32}
                required
                hint={t("hint.phone")}
                defaultValue={values["phone"]}
                {...(error("phone") !== undefined ? { error: error("phone") as string } : {})}
              />
            </div>
          </div>
          <div className="mergecolor">
            <small>{t("signup.security")}</small>
          </div>
          <PasswordFields error={error} />
          <div className="mergecolor">
            <small>{t("signup.consents")}</small>
          </div>
          <ConsentBoxes locale={locale} error={error} />
        </>
      )}
    </AuthForm>
  );
}
