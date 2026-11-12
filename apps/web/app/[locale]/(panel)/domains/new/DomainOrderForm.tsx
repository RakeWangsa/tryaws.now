"use client";

import { Field, MoneyText, OptionGroup, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";

// The form of /domains/new (16.10): the registrant contact, the typed confirmation that repeats the
// exact domain name, and the summary (configurator.html pattern). The name and the price were fixed on
// the server; this file adds and rounds nothing (R4). The name travels as a hidden field and the
// customer types it again in a visible one: a mismatch is refused by the core before anything is sealed.

export function DomainOrderForm({
  name,
  priceMinor,
  review,
  numerals,
  action,
}: {
  name: string;
  priceMinor: bigint;
  review: boolean;
  numerals: "beng" | "latn";
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Domains.new");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const fieldError = (key: string): string | undefined => {
    const code = state.fields?.[key];
    if (code === undefined) return undefined;
    if (key === "confirmName") return t("mismatch");
    if (key === "name" && code === "taken") return t("taken");
    return tf("field.invalid");
  };
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const text = (
    key: string,
    label: string,
    extra: { hint?: string; type?: "email" | "tel"; optional?: boolean } = {},
  ) => (
    <Field
      key={key}
      name={key}
      label={label}
      maxLength={255}
      autoComplete="off"
      {...(extra.type !== undefined ? { type: extra.type } : {})}
      {...(extra.hint !== undefined ? { hint: extra.hint } : {})}
      {...(extra.optional === true ? { optional: true } : { required: true })}
      {...(fieldError(key) !== undefined ? { error: fieldError(key) as string } : {})}
    />
  );

  return (
    <form action={formAction} className="config" noValidate>
      {topError !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {topError}
        </div>
      ) : null}
      {fieldError("name") !== undefined ? (
        <p className="tc-field-error" role="alert">
          {fieldError("name")}
        </p>
      ) : null}
      <input type="hidden" name="name" value={name} />
      <div className="row">
        <div className="col-lg-8">
          <OptionGroup
            kind="radio"
            name="contactType"
            legend={t("step.contact")}
            options={[
              { value: "PERSON", label: t("field.person") },
              { value: "COMPANY", label: t("field.company") },
            ]}
            defaultValue="PERSON"
          />
          {text("firstName", t("field.firstName"))}
          {text("lastName", t("field.lastName"))}
          {text("organizationName", t("field.organizationName"), { optional: true })}
          {text("email", t("field.email"), { type: "email", hint: t("field.emailHint") })}
          {text("phoneNumber", t("field.phoneNumber"), { type: "tel", hint: t("field.phoneHint") })}
          {text("addressLine1", t("field.addressLine1"))}
          {text("addressLine2", t("field.addressLine2"), { optional: true })}
          {text("city", t("field.city"))}
          {text("state", t("field.state"))}
          {text("countryCode", t("field.countryCode"), { hint: t("field.countryHint") })}
          {text("zipCode", t("field.zipCode"))}
          <h2 className="h5 mergecolor mt-4">{t("step.confirm")}</h2>
          {text("confirmName", t("field.confirmName"), {
            hint: t("field.confirmHint", { name }),
          })}
          <p className="form-text seccolor">{t("noRefund")}</p>
        </div>
        <div className="col-lg-4">
          <SummarySidebar
            title={t("summary.title")}
            planTitle={name}
            planLines={[]}
            rows={[
              { label: t("summary.term"), value: t("summary.termValue") },
              ...(review ? [{ label: t("summary.review"), value: t("summary.reviewYes") }] : []),
              {
                label: t("summary.price"),
                value: <MoneyText minor={priceMinor} mode="exact" numerals={numerals} />,
                strong: true,
              },
            ]}
            action={
              <SubmitButton variant="primary" className="w-100">
                {t("submit")}
              </SubmitButton>
            }
          />
        </div>
      </div>
    </form>
  );
}
