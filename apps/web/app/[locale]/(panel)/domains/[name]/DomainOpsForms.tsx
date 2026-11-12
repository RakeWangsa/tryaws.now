"use client";

import { SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";

// The two domain actions that reach Route 53 Domains through the operations queue (WPU-B2): send the
// verification e-mail again, change the name servers. One idempotency id for this page view (R7). The
// result is a fixed key (U6); a typed value is never shown back (R14).

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

function useFailure(state: FormState): string | null {
  const t = useTranslations("Domains.detail.opsError");
  const tf = useTranslations("Flow");
  if (state.error === undefined) return null;
  if (t.has(state.error)) return t(state.error);
  return tf.has(`error.${state.error}`) ? tf(`error.${state.error}`) : tf("error.unavailable");
}

export function ResendVerificationForm({
  name,
  requestId,
  action,
}: {
  name: string;
  requestId: string;
  action: Action;
}) {
  const t = useTranslations("Domains.detail.verification");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const failed = useFailure(state);
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="requestId" value={requestId} />
      {failed !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          {failed}
        </div>
      ) : null}
      {state.done === "verificationSent" ? <p role="status">{t("resendDone")}</p> : null}
      <SubmitButton variant="secondary">{t("resend")}</SubmitButton>
    </form>
  );
}

export function NameServersForm({
  name,
  requestId,
  action,
}: {
  name: string;
  requestId: string;
  action: Action;
}) {
  const t = useTranslations("Domains.detail.nsChange");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const failed = useFailure(state);
  const fields = state.fields ?? {};
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="requestId" value={requestId} />
      <p className="seccolor mb-3">{t("note")}</p>
      <div className="mb-3">
        <label className="form-label" htmlFor="ns-list">
          {t("field")}
        </label>
        <textarea
          id="ns-list"
          name="nameServers"
          className="form-control"
          rows={4}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="ns-hint"
          aria-invalid={fields["nameServers"] !== undefined}
        />
        <div id="ns-hint" className="form-text">
          {fields["nameServers"] !== undefined ? t("invalid") : t("hint")}
        </div>
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="ns-confirm">
          {t("confirm")}
        </label>
        <input
          id="ns-confirm"
          name="confirmName"
          type="text"
          className="form-control"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="ns-confirm-hint"
          aria-invalid={fields["confirmName"] !== undefined}
        />
        <div id="ns-confirm-hint" className="form-text">
          {fields["confirmName"] !== undefined ? t("mismatch") : t("confirmHint", { name })}
        </div>
      </div>
      {failed !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          {failed}
        </div>
      ) : null}
      {state.done === "nameServersRequested" ? <p role="status">{t("done")}</p> : null}
      <SubmitButton variant="secondary">{t("submit")}</SubmitButton>
    </form>
  );
}
