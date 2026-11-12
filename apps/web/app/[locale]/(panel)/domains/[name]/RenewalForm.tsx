"use client";

import { SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";

// The renewal toggle of 16.10. One idempotency id for this page view (R7). The result is a fixed key.
export function RenewalForm({
  name,
  autoRenew,
  requestId,
  action,
}: {
  name: string;
  autoRenew: boolean;
  requestId: string;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Domains.detail.renewal");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const failed =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="enabled" value={autoRenew ? "off" : "on"} />
      <p className="mb-2">
        <strong>{autoRenew ? t("on") : t("off")}</strong>
      </p>
      <p className="seccolor mb-3">{t("note")}</p>
      {failed !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          {failed}
        </div>
      ) : null}
      {state.done === "autoRenewOn" || state.done === "autoRenewOff" ? (
        <p role="status">{t(state.done)}</p>
      ) : null}
      <SubmitButton variant="secondary">{autoRenew ? t("turnOff") : t("turnOn")}</SubmitButton>
    </form>
  );
}
