import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { Field } from "@tc/ui";
import { webMessages } from "../../../../i18n/messages.ts";
import { AuthAlert } from "./AuthAlert.tsx";
import { AuthBody, AuthCard } from "./AuthCard.tsx";
import { AuthFormView } from "./AuthForm.tsx";
import { ConsentBoxes } from "./ConsentBoxes.tsx";
import { PasswordFields } from "./PasswordFields.tsx";
import { ForgotContent } from "../forgot-password/ForgotContent.tsx";
import { LoginContent } from "../login/LoginContent.tsx";
import { ResetContent } from "../reset-password/ResetContent.tsx";
import { SignUpContent } from "../signup/SignUpContent.tsx";
import { VerifyContent } from "../verify/VerifyContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id. Used by the
// mockup-anchors test only. Task 9 adds the states of the five pages here.

export function html(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

type Renderer = (locale: Locale) => string;

const noop = (): void => undefined;

export const STATE_RENDERERS: Record<string, Renderer> = {
  "auth.card": (l) =>
    html(
      <AuthCard title="T" intro="I">
        <p>x</p>
      </AuthCard>,
      l,
    ),
  "auth.tabs.login": (l) =>
    html(
      <AuthCard title="T" tabs={{ active: "login", locale: l }}>
        <p>x</p>
      </AuthCard>,
      l,
    ),
  "auth.tabs.signup": (l) =>
    html(
      <AuthCard title="T" tabs={{ active: "signup", locale: l }}>
        <p>x</p>
      </AuthCard>,
      l,
    ),
  "auth.body": (l) =>
    html(
      <AuthBody heading="H">
        <p>x</p>
      </AuthBody>,
      l,
    ),
  "auth.fields": (l) =>
    html(
      <AuthFormView state={{ status: "idle" }} action={noop} hidden={{}} submitLabel="Go">
        {({ error }) => (
          <>
            <Field name="email" label="E" type="email" />
            <PasswordFields error={error} />
          </>
        )}
      </AuthFormView>,
      l,
    ),
  "auth.consent": (l) => html(<ConsentBoxes locale={l} error={() => undefined} />, l),
  "auth.alert.danger": (l) => html(<AuthAlert kind="danger">m</AuthAlert>, l),
  "auth.alert.warning": (l) => html(<AuthAlert kind="warning">m</AuthAlert>, l),
  "auth.alert.info": (l) => html(<AuthAlert kind="info">m</AuthAlert>, l),
  "auth.alert.success": (l) => html(<AuthAlert kind="success">m</AuthAlert>, l),
  "login.idle": (l) =>
    html(<LoginContent locale={l} next={undefined} banner={null} available />, l),
  "login.banner.verified": (l) =>
    html(<LoginContent locale={l} next={undefined} banner="verified" available />, l),
  "login.notAvailable": (l) =>
    html(<LoginContent locale={l} next={undefined} banner={null} available={false} />, l),
  "login.failure": (l) =>
    html(
      <AuthFormView
        state={{ status: "error", code: "sign_in_failed", ref: "0a1b2c3d" }}
        action={noop}
        hidden={{}}
        submitLabel="Go"
      >
        {() => null}
      </AuthFormView>,
      l,
    ),
  "login.rateLimited": (l) =>
    html(
      <AuthFormView
        state={{ status: "error", code: "rate_limited", retryAfterSeconds: 300, ref: "0a1b2c3d" }}
        action={noop}
        hidden={{}}
        submitLabel="Go"
      >
        {() => null}
      </AuthFormView>,
      l,
    ),
  "signup.idle": (l) => html(<SignUpContent locale={l} next={undefined} available />, l),
  "signup.fieldError": (l) =>
    html(
      <AuthFormView
        state={{
          status: "error",
          code: "invalid",
          fields: { email: "invalid" },
          values: { email: "a@b" },
          ref: "0a1b2c3d",
        }}
        action={noop}
        hidden={{}}
        submitLabel="Go"
      >
        {({ error }) => (
          <div className="row mb-5">
            <div className="col-md-6 position-relative">
              <Field
                name="email"
                label="E"
                type="email"
                {...(error("email") !== undefined ? { error: error("email") as string } : {})}
              />
            </div>
          </div>
        )}
      </AuthFormView>,
      l,
    ),
  "verify.email": (l) =>
    html(
      <VerifyContent
        locale={l}
        next={undefined}
        available
        step={{ kind: "email", email: "a@example.test", resendAt: 1 }}
      />,
      l,
    ),
  "verify.phone": (l) =>
    html(
      <VerifyContent
        locale={l}
        next={undefined}
        available
        step={{
          kind: "phone",
          step: {
            kind: "ready",
            phone: "+8801712345678",
            challenge: { phoneMasked: "+880*******678", resendAt: 1 },
            idempotencyKey: "key-1",
          },
        }}
      />,
      l,
    ),
  "forgot.idle": (l) => html(<ForgotContent locale={l} available />, l),
  "reset.idle": (l) => html(<ResetContent locale={l} email="" available />, l),
};
