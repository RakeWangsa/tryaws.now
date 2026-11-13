"use client";

import { SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import type { AutoRenewView } from "../../../../server/auto-renew-view.ts";

// WPU-Z14: the auto-renew switch of a detail page (and, `compact`, of one row of a table). The form says the
// state it asks for (on or off), so a repeat of the same click sets the same value (R7). The server checks
// the session, the flag, the ownership and the subscription state again (R8, R9). The result is a fixed key.

export type AutoRenewAction = (previous: FormState, form: FormData) => Promise<FormState>;

function Notice({ state }: { state: FormState }) {
  const t = useTranslations("AutoRenew");
  const router = useRouter();
  useEffect(() => {
    // The page shows the new state after a success.
    if (state.done !== undefined) router.refresh();
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
      </div>
    );
  }
  if (state.done === "autoRenewOn" || state.done === "autoRenewOff") {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {t(`done.${state.done}`)}
      </div>
    );
  }
  return null;
}

export function AutoRenewSwitch({
  action,
  view,
  compact = false,
}: {
  action: AutoRenewAction;
  view: AutoRenewView;
  compact?: boolean;
}) {
  const t = useTranslations("AutoRenew");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const blocked = !view.autoRenew && !view.canTurnOn;
  const fields = (
    <>
      <input type="hidden" name="resourceId" value={view.resourceId} />
      <input type="hidden" name="autoRenew" value={view.autoRenew ? "off" : "on"} />
    </>
  );
  const button = (
    <SubmitButton
      size={compact ? "sm" : "md"}
      variant={compact ? "default" : "secondary"}
      disabled={blocked}
    >
      {view.autoRenew ? t("turnOff") : t("turnOn")}
    </SubmitButton>
  );
  if (compact) {
    return (
      <form action={formAction} noValidate>
        {fields}
        <Notice state={state} />
        <span className="me-2">{view.autoRenew ? t("on") : t("off")}</span>
        {button}
      </form>
    );
  }
  return (
    <form action={formAction} noValidate className="mt-4">
      <h3 className="mergecolor h4">{t("title")}</h3>
      {fields}
      <Notice state={state} />
      <p className="mb-2">
        <strong>{view.autoRenew ? t("on") : t("off")}</strong>
      </p>
      <p className="seccolor mb-3">{t("hint")}</p>
      {blocked ? <p className="seccolor">{t("notNow")}</p> : null}
      {button}
    </form>
  );
}
