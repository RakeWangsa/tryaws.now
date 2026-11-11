"use client";

import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { AuthAlert } from "../_components/AuthAlert.tsx";
import { AuthForm } from "../_components/AuthForm.tsx";
import { ResendTimer } from "../_components/ResendTimer.tsx";
import { sendPhoneCodeAction, verifyPhoneCodeAction } from "./actions.ts";

/**
 * The phone step (open point 15). Without an open code: the number (prefilled, editable) and "send
 * code". With one: a notice with the masked number, the code field, and "send again" with the timer.
 * The idempotency key was made on the server when the page rendered (R7).
 */
export function PhoneVerifyForms({
  locale,
  next,
  phone,
  challenge,
  idempotencyKey,
}: {
  locale: Locale;
  next: string;
  phone: string;
  challenge: { phoneMasked: string; resendAt: number } | null;
  idempotencyKey: string;
}) {
  const t = useTranslations("Auth");
  const common = { locale, ...(next !== "" ? { next } : {}) };

  const numberField = (
    error: (n: string) => string | undefined,
    values: Record<string, string>,
  ) => (
    <div className="row">
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
          defaultValue={values["phone"] ?? phone}
          {...(error("phone") !== undefined ? { error: error("phone") as string } : {})}
        />
      </div>
    </div>
  );

  if (challenge === null) {
    return (
      <AuthForm
        action={sendPhoneCodeAction}
        hidden={{ ...common, idempotencyKey }}
        submitLabel={t("verify.phone.send")}
      >
        {({ error, values }) => numberField(error, values)}
      </AuthForm>
    );
  }

  return (
    <>
      <AuthAlert kind="info">{t("verify.phone.sent", { phone: challenge.phoneMasked })}</AuthAlert>
      <AuthForm
        action={verifyPhoneCodeAction}
        hidden={common}
        submitLabel={t("verify.phone.submit")}
      >
        {({ error }) => (
          <div className="row">
            <div className="col-md-6 position-relative">
              <Field
                name="code"
                label={t("field.smsCode")}
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
        <AuthForm action={sendPhoneCodeAction} hidden={{ ...common, idempotencyKey, phone }}>
          {() => <ResendTimer resendAt={challenge.resendAt} label={t("verify.phone.resend")} />}
        </AuthForm>
      </div>
    </>
  );
}
