"use client";

import { Card, Field, OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";

// The form that makes a DNS zone (WPU-G6, 16.11 step 1): the name of the domain and the declaration that
// the customer controls it. Nothing is charged here: the form makes a draft and goes to the review page,
// where the price is shown and the customer confirms. The server checks every rule again; the errors
// below come from its answer and never repeat what was typed (R11, U6, U8).

export type CreateZoneAction = (previous: FormState, form: FormData) => Promise<FormState>;

export function CreateZoneForm({ action }: { action: CreateZoneAction }) {
  const t = useTranslations("Dns.create");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const fieldText = (key: string): string | undefined => {
    const code = state.fields?.[key];
    if (code === undefined) return undefined;
    return t.has(`fieldError.${code}`) ? t(`fieldError.${code}`) : tf("field.invalid");
  };
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const nameError = fieldText("zoneName") ?? fieldText("price");
  const declareError = fieldText("declaredControl");

  return (
    <Card as="section" title={t("title")} className="mb-4">
      <p className="seccolor">{t("intro")}</p>
      <form action={formAction} noValidate aria-label={t("title")}>
        {topError !== null ? (
          <div className="alert alert-danger text-start" role="alert">
            <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
            {topError}
          </div>
        ) : null}
        <Field
          name="zoneName"
          label={t("name")}
          hint={t("nameHint")}
          maxLength={253}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          {...(nameError !== undefined ? { error: nameError } : {})}
        />
        <OptionGroup
          kind="checkbox"
          name="declaredControl"
          legend={t("declareTitle")}
          options={[{ value: "on", label: t("declare") }]}
          required
          {...(declareError !== undefined ? { error: declareError } : {})}
        />
        <p className="form-text seccolor">{t("price")}</p>
        <p className="form-text seccolor">{t("notDelegated")}</p>
        <SubmitButton variant="primary">{t("submit")}</SubmitButton>
      </form>
    </Card>
  );
}
