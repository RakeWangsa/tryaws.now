"use client";

import { Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { SettingsNotice, useFieldError } from "../SettingsNotice.tsx";
import type { TotpFormState } from "./actions.ts";

// WPU-X11: the authenticator (TOTP) of /settings/security. Client Components only for the interaction
// state: the answer of the last action and the 60-second timer of the secret (U9). The secret exists only
// in the answer of the start action, is shown once, never written to storage, and hidden after 60 s.

type TotpAction = (previous: TotpFormState, form: FormData) => Promise<TotpFormState>;
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export const SECRET_VISIBLE_MS = 60_000;

/** Groups of four, so the key is easier to type into an app. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Step 1 (start) and step 2 (the code from the app). */
export function TotpSetupForms({
  start,
  confirm,
  signInHref,
}: {
  start: TotpAction;
  confirm: TotpAction;
  signInHref: string;
}) {
  const t = useTranslations("Settings.security.totp");
  const [started, startAction, starting] = useActionState<TotpFormState, FormData>(
    start,
    INITIAL_FORM_STATE,
  );
  const [confirmed, confirmAction, confirming] = useActionState<TotpFormState, FormData>(
    confirm,
    INITIAL_FORM_STATE,
  );
  const [hidden, setHidden] = useState(false);
  const secret = started.secret;
  const error = useFieldError(confirmed);

  useEffect(() => {
    if (secret === undefined) return;
    setHidden(false);
    const timer = setTimeout(() => setHidden(true), SECRET_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [secret]);

  if (confirmed.done === "enabled") {
    return <SettingsNotice state={confirmed} doneText={t("enabled")} signInHref={signInHref} />;
  }

  return (
    <>
      <form action={startAction} noValidate>
        <SettingsNotice state={started} doneText={null} signInHref={signInHref} />
        {secret === undefined ? (
          <SubmitButton variant="primary" pending={starting} icon="fas fa-shield-alt">
            {t("start")}
          </SubmitButton>
        ) : null}
      </form>
      {secret !== undefined ? (
        <>
          <p className="mb-2">{t("step1")}</p>
          {hidden ? (
            <p className="seccolor" role="status">
              <i className="fas fa-eye-slash me-2" aria-hidden="true" />
              {t("hidden")}
            </p>
          ) : (
            <div className="mb-3">
              {started.qr !== undefined ? (
                <p className="mb-3">
                  <svg
                    className="tc-totp-qr"
                    width="200"
                    height="200"
                    viewBox={`0 0 ${started.qr.size + 2 * started.qr.margin} ${started.qr.size + 2 * started.qr.margin}`}
                    shapeRendering="crispEdges"
                    role="img"
                    aria-label={t("qrLabel")}
                  >
                    {/* Black on white in every theme: a scanner needs the contrast. */}
                    <rect width="100%" height="100%" fill="#ffffff" />
                    <path d={started.qr.d} fill="#000000" />
                  </svg>
                </p>
              ) : null}
              <p className="mb-1 seccolor">{t("secretLabel")}</p>
              <p className="mb-2">
                <code className="fs-5 text-break" translate="no">
                  {groupSecret(secret)}
                </code>
              </p>
              {started.otpauthUri !== undefined ? (
                <p className="mb-2">
                  <a className="golink" href={started.otpauthUri}>
                    <i className="fas fa-mobile-alt me-2" aria-hidden="true" />
                    {t("openApp")}
                  </a>
                </p>
              ) : null}
              <p className="seccolor small mb-0">
                <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
                {t("secretNote")}
              </p>
            </div>
          )}
          <form action={confirmAction} noValidate>
            <SettingsNotice state={confirmed} doneText={null} signInHref={signInHref} />
            <p className="mb-2">{t("step2")}</p>
            <Field
              name="code"
              label={t("code")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              required
              {...(error("code") !== undefined ? { error: error("code") as string } : {})}
            />
            <SubmitButton variant="primary" pending={confirming}>
              {t("confirm")}
            </SubmitButton>
          </form>
        </>
      ) : null}
    </>
  );
}

/** Switching the authenticator off (fresh sign-in); buying is blocked again until it is on. */
export function TotpDisableForm({ action, signInHref }: { action: Action; signInHref: string }) {
  const t = useTranslations("Settings.security.totp");
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  if (state.done === "disabled") {
    return <SettingsNotice state={state} doneText={t("disabled")} signInHref={signInHref} />;
  }
  return (
    <form action={formAction} noValidate>
      <SettingsNotice state={state} doneText={null} signInHref={signInHref} />
      <p className="seccolor">{t("disableBody")}</p>
      <SubmitButton variant="default" pending={pending}>
        {t("disable")}
      </SubmitButton>
    </form>
  );
}
