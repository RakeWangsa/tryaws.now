"use client";

import { Field, FormBlock, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { NotifyMeState } from "../../../../../server/public/notify-me.ts";
import { notifyMeAction } from "./actions.ts";

const IDLE: NotifyMeState = { status: "idle" };

/** The "notify me" form of a product whose flag is off (U8: a Server Action, errors from the same checks, inert while pending). */
export function NotifyForm({ family, name }: { family: string; name: string }) {
  const t = useTranslations("Public");
  const [state, action] = useActionState(notifyMeAction, IDLE);

  if (state.status === "done") {
    return (
      <div className="alert alert-success text-start" role="status">
        <strong>{t("soon.doneTitle")}</strong> {t("soon.done")}
      </div>
    );
  }
  const error = state.status === "error" ? t(`soon.error.${state.code}`) : null;
  return (
    <form action={action} noValidate>
      <input type="hidden" name="family" value={family} />
      <FormBlock>
        <Field
          name="email"
          type="email"
          label={t("soon.formLabel", { name })}
          icon="fas fa-envelope"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          required
          spellCheck={false}
          autoCapitalize="off"
          placeholder={t("soon.emailPlaceholder")}
          {...(error !== null ? { error } : {})}
        />
      </FormBlock>
      <SubmitButton variant="primary" className="mt-3">
        {t("soon.submit")}
      </SubmitButton>
    </form>
  );
}
