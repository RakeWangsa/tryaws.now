"use client";

import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { AuthForm } from "../_components/AuthForm.tsx";
import { ResendTimer } from "../_components/ResendTimer.tsx";
import { confirmEmailAction, resendEmailCodeAction } from "./actions.ts";

/**
 * The email step: the address (prefilled from the pending cookie, editable) and the code from the
 * email; below it the "send again" form with the resend timer.
 */
export function EmailVerifyForms({
  locale,
  email,
  next,
  resendAt,
}: {
  locale: Locale;
  email: string;
  next: string;
  /** Epoch seconds; null when no code was sent from this browser. */
  resendAt: number | null;
}) {
  const t = useTranslations("Auth");
  return (
    <>
      <AuthForm
        action={confirmEmailAction}
        hidden={{ locale, ...(next !== "" ? { next } : {}) }}
        submitLabel={t("verify.email.submit")}
      >
        {({ error, values }) => (
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
        )}
      </AuthForm>
      <div className="mt-4">
        <AuthForm
          action={resendEmailCodeAction}
          hidden={{ locale, ...(email !== "" ? { email } : {}) }}
        >
          {({ error, values }) => (
            <>
              {email === "" ? (
                <Field
                  name="email"
                  type="email"
                  label={t("field.email")}
                  icon="fas fa-envelope"
                  autoComplete="username"
                  inputMode="email"
                  maxLength={320}
                  required
                  defaultValue={values["email"]}
                  {...(error("email") !== undefined ? { error: error("email") as string } : {})}
                />
              ) : null}
              <ResendTimer resendAt={resendAt} label={t("verify.resend")} />
            </>
          )}
        </AuthForm>
      </div>
    </>
  );
}
