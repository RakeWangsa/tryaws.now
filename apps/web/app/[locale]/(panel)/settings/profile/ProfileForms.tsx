"use client";

import { Field, OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useRef } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { SettingsNotice, useFieldError } from "../SettingsNotice.tsx";

// The forms of /settings/profile (U8: field errors from the server's own check, a button that is
// inert while its action runs). E-mail and phone change in two steps, each its own action: the code
// is asked only after the server accepted the new address or number.

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export function DetailsForm({
  action,
  name,
  locale,
  signInHref,
}: {
  action: Action;
  name: string;
  locale: "bn" | "en";
  signInHref: string;
}) {
  const t = useTranslations("Settings.profile.details");
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const error = useFieldError(state);
  return (
    <form action={formAction} noValidate>
      <SettingsNotice
        state={state}
        doneText={state.done === "saved" ? t("saved") : null}
        signInHref={signInHref}
      />
      <Field
        name="name"
        label={t("name")}
        hint={t("nameHint")}
        defaultValue={name}
        maxLength={80}
        required
        autoComplete="name"
        {...(error("name") !== undefined ? { error: error("name") as string } : {})}
      />
      <OptionGroup
        kind="radio"
        name="locale"
        legend={t("locale")}
        defaultValue={locale}
        required
        options={[
          { value: "bn", label: t("localeBn") },
          { value: "en", label: t("localeEn") },
        ]}
      />
      <SubmitButton variant="primary" pending={pending}>
        {t("save")}
      </SubmitButton>
    </form>
  );
}

export function EmailChange({
  currentEmail,
  startAction,
  confirmAction,
  signInHref,
}: {
  currentEmail: string;
  startAction: Action;
  confirmAction: Action;
  signInHref: string;
}) {
  const t = useTranslations("Settings.profile.email");
  const [started, start, startPending] = useActionState(startAction, INITIAL_FORM_STATE);
  const [confirmed, confirm, confirmPending] = useActionState(confirmAction, INITIAL_FORM_STATE);
  const startError = useFieldError(started);
  const confirmError = useFieldError(confirmed);
  const pendingEmail = started.done === "codeSent" ? (started.fields?.["pendingEmail"] ?? "") : "";
  const changed = confirmed.done === "changed";

  return (
    <>
      <p className="seccolor mb-3">
        {t("current")}: <strong>{currentEmail}</strong>
      </p>
      {changed ? null : (
        <form action={start} noValidate className="mb-4">
          <SettingsNotice
            state={started}
            doneText={started.done === "codeSent" ? t("sent") : null}
            signInHref={signInHref}
          />
          <Field
            name="email"
            type="email"
            label={t("newLabel")}
            hint={t("newHint")}
            required
            autoComplete="email"
            maxLength={254}
            {...(startError("email") !== undefined ? { error: startError("email") as string } : {})}
          />
          <SubmitButton variant="secondary" pending={startPending}>
            {t("sendCode")}
          </SubmitButton>
        </form>
      )}
      {pendingEmail !== "" && !changed ? (
        <form action={confirm} noValidate>
          <SettingsNotice state={confirmed} doneText={null} signInHref={signInHref} />
          <input type="hidden" name="email" value={pendingEmail} />
          <Field
            name="code"
            label={t("codeLabel")}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            {...(confirmError("code") !== undefined
              ? { error: confirmError("code") as string }
              : {})}
          />
          <SubmitButton variant="primary" pending={confirmPending}>
            {t("confirm")}
          </SubmitButton>
        </form>
      ) : null}
      {changed ? (
        <SettingsNotice state={confirmed} doneText={t("changed")} signInHref={signInHref} />
      ) : null}
    </>
  );
}

export function PhoneChange({
  phoneMasked,
  phoneVerified,
  startAction,
  confirmAction,
  signInHref,
}: {
  phoneMasked: string | null;
  phoneVerified: boolean;
  startAction: Action;
  confirmAction: Action;
  signInHref: string;
}) {
  const t = useTranslations("Settings.profile.phone");
  const [started, start, startPending] = useActionState(startAction, INITIAL_FORM_STATE);
  const [confirmed, confirm, confirmPending] = useActionState(confirmAction, INITIAL_FORM_STATE);
  const startError = useFieldError(started);
  const confirmError = useFieldError(confirmed);
  // One key for one number: a second press of the button with the same number is the same request (R7).
  const key = useRef<string | null>(null);
  const changed = confirmed.done === "changed";
  const sentTo = started.done === "codeSent" ? (started.fields?.["phoneMasked"] ?? "") : "";

  return (
    <>
      <p className="seccolor mb-3">
        {t("current")}: <strong>{phoneMasked === null ? t("none") : phoneMasked}</strong>
        {phoneMasked !== null && phoneVerified ? (
          <>
            {" "}
            <span className="badge bg-purple">{t("verified")}</span>
          </>
        ) : null}
      </p>
      {changed ? null : (
        <form
          noValidate
          className="mb-4"
          action={(form) => {
            key.current ??= crypto.randomUUID();
            form.set("idempotencyKey", key.current);
            startTransition(() => start(form));
          }}
        >
          <SettingsNotice
            state={started}
            doneText={sentTo !== "" ? `${t("sent")}: ${sentTo}` : null}
            signInHref={signInHref}
          />
          <Field
            name="phone"
            type="tel"
            label={t("newLabel")}
            hint={t("newHint")}
            required
            autoComplete="tel"
            maxLength={20}
            onChange={() => {
              key.current = null;
            }}
            {...(startError("phone") !== undefined ? { error: startError("phone") as string } : {})}
          />
          <SubmitButton variant="secondary" pending={startPending}>
            {t("sendCode")}
          </SubmitButton>
        </form>
      )}
      {sentTo !== "" && !changed ? (
        <form action={confirm} noValidate>
          <SettingsNotice state={confirmed} doneText={null} signInHref={signInHref} />
          <Field
            name="code"
            label={t("codeLabel")}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            {...(confirmError("code") !== undefined
              ? { error: confirmError("code") as string }
              : {})}
          />
          <SubmitButton variant="primary" pending={confirmPending}>
            {t("confirm")}
          </SubmitButton>
        </form>
      ) : null}
      {changed ? (
        <SettingsNotice state={confirmed} doneText={t("changed")} signInHref={signInHref} />
      ) : null}
    </>
  );
}
