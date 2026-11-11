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
};
