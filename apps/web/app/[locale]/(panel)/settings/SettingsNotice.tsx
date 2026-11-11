"use client";

import { useTranslations } from "next-intl";
import type { FormState } from "../../../../server/action-state.ts";

// The notice above a settings form: the public error key as text in the customer's language (a fresh
// sign-in error carries the link to sign in again), or the success key. State is never colour alone:
// an icon and the text come with it (U11).

export function SettingsNotice({
  state,
  doneText,
  signInHref,
}: {
  state: FormState;
  /** The success text for `state.done`, chosen by the form. */
  doneText: string | null;
  signInHref: string;
}) {
  const t = useTranslations("Settings");
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
        {state.error === "fresh_sign_in_required" ? (
          <>
            {" "}
            <a href={signInHref}>{t("fresh.signIn")}</a>
          </>
        ) : null}
      </div>
    );
  }
  if (state.done !== undefined && doneText !== null) {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {doneText}
      </div>
    );
  }
  return null;
}

/** The text of a field error code (the code is a public key, never a message from the provider). */
export function useFieldError(state: FormState): (name: string) => string | undefined {
  const t = useTranslations("Settings.field");
  return (name) => {
    if (state.error === undefined) return undefined;
    const code = state.fields?.[name];
    if (code === undefined) return undefined;
    return t.has(code) ? t(code) : t("invalid");
  };
}
