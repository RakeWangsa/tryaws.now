"use client";

import { Field, FormBlock, OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { PublicSupportState } from "../../../../server/public/support-form.ts";
import { HONEYPOT_FIELD } from "../../../../server/public/support-form-fields.ts";
import { publicSupportAction } from "./actions.ts";

const IDLE: PublicSupportState = { status: "idle" };
const CATEGORIES = ["billing", "technical", "kyc", "domain", "abuse", "other"] as const;

/** The public support form (U8: a Server Action, errors from the same zod schema, inert while pending). */
export function PublicSupportForm() {
  const t = useTranslations("Public");
  const [state, action] = useActionState(publicSupportAction, IDLE);

  if (state.status === "done") {
    return (
      <div className="alert alert-success text-start" role="status">
        <strong>{t("support.form.doneTitle")}</strong> {t("support.form.done")}
      </div>
    );
  }
  const fields = state.status === "error" ? (state.fields ?? []) : [];
  const bad = (name: string): { error: string } | Record<string, never> =>
    fields.includes(name) ? { error: t("support.form.fieldInvalid") } : {};

  return (
    <form action={action} noValidate>
      {state.status === "error" ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t(`support.form.error.${state.code}`)}
          {state.ref !== undefined ? (
            <span className="d-block">{t("support.form.reference", { ref: state.ref })}</span>
          ) : null}
        </div>
      ) : null}
      <FormBlock>
        <Field
          name="email"
          type="email"
          label={t("support.form.email")}
          icon="fas fa-envelope"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          required
          spellCheck={false}
          autoCapitalize="off"
          placeholder={t("support.form.emailPlaceholder")}
          {...bad("email")}
        />
        <Field
          name="name"
          label={t("support.form.name")}
          icon="fas fa-user"
          autoComplete="name"
          maxLength={100}
          optional
          {...bad("name")}
        />
        <OptionGroup
          kind="radio"
          name="category"
          legend={t("support.form.category")}
          defaultValue="technical"
          required
          options={CATEGORIES.map((value) => ({
            value,
            label: t(`support.form.categories.${value}`),
          }))}
          {...bad("category")}
        />
        <Field
          name="subject"
          label={t("support.form.subject")}
          icon="fas fa-file-alt"
          maxLength={120}
          autoComplete="off"
          required
          {...bad("subject")}
        />
        <Field
          name="message"
          label={t("support.form.message")}
          multiline
          rows={6}
          maxLength={5000}
          required
          {...bad("message")}
        />
      </FormBlock>
      {/* The honeypot: a person never sees it and a screen reader skips it. */}
      <div className="visually-hidden" aria-hidden="true">
        <label htmlFor="tc-support-hp">{t("support.form.honeypot")}</label>
        <input
          id="tc-support-hp"
          name={HONEYPOT_FIELD}
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      <SubmitButton variant="primary" className="mt-3">
        {t("support.form.submit")}
      </SubmitButton>
    </form>
  );
}
