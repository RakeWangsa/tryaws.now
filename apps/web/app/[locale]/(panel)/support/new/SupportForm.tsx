"use client";

import { Button, Field, OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { SupportActionResult } from "./actions.ts";

// The form of /support/new (16.10): category, subject, message. The server checks everything again
// (support-request.ts); the browser sends one idempotency key for one form, so a second click or a
// retry after a lost answer is the same request (R7). This file imports nothing from @tc/core.

export type SupportAction = (input: unknown) => Promise<SupportActionResult>;

export const SUPPORT_CATEGORY_VALUES = [
  "billing",
  "technical",
  "kyc",
  "domain",
  "abuse",
  "other",
] as const;

/** The success state: the reference of the new request. Exported for the mockup cross-check. */
export function SupportDone({
  id,
  replayed,
  onAgain,
}: {
  id: string;
  replayed: boolean;
  onAgain: () => void;
}) {
  const t = useTranslations("SupportForm");
  return (
    <div className="alert alert-info text-start" role="status">
      <i className="fas fa-check-circle me-2" aria-hidden="true" />
      <strong>{t("done.title")}</strong>
      <p className="mb-1">{replayed ? t("done.replayed") : t("done.body")}</p>
      <p className="mb-3">
        {t("done.reference")}: <code className="text-break">{id}</code>
      </p>
      <Button variant="default" onClick={onAgain}>
        {t("done.again")}
      </Button>
    </div>
  );
}

export function SupportForm({
  action,
  resources = [],
  initialError = null,
}: {
  action: SupportAction;
  /** The customer's own named resources; the picker is shown only when there are some. */
  resources?: readonly { id: string; name: string }[];
  /** Only for the tests of the error state. */
  initialError?: string | null;
}) {
  const t = useTranslations("SupportForm");
  const relatedId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({});
  const [done, setDone] = useState<{ id: string; replayed: boolean } | null>(null);
  const [formKey, setFormKey] = useState(0);
  // One key for one filled-in form; a new form (after success) gets a new key.
  const keyRef = useRef<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    keyRef.current ??= crypto.randomUUID();
    setError(null);
    setFields({});
    setPending(true);
    try {
      const result = await action({
        category: String(form.get("category") ?? ""),
        subject: String(form.get("subject") ?? ""),
        message: String(form.get("message") ?? ""),
        relatedResourceId: String(form.get("relatedResourceId") ?? ""),
        idempotencyKey: keyRef.current,
      });
      if (result.ok) {
        setDone({ id: result.id, replayed: result.replayed });
      } else {
        setError(result.error);
        if ("fields" in result && result.fields !== undefined) setFields(result.fields);
      }
    } catch {
      setError("unavailable");
    }
    setPending(false);
  }

  if (done !== null) {
    return (
      <SupportDone
        id={done.id}
        replayed={done.replayed}
        onAgain={() => {
          keyRef.current = null;
          setDone(null);
          setFormKey((n) => n + 1);
        }}
      />
    );
  }

  const invalid = (name: string): { error: string } | Record<string, never> =>
    fields[name] !== undefined ? { error: t("field.invalid") } : {};

  return (
    <form key={formKey} onSubmit={onSubmit} noValidate>
      {error !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`) ? t(`error.${error}`) : t("error.unavailable")}
        </div>
      ) : null}
      <OptionGroup
        kind="radio"
        name="category"
        legend={t("form.category.legend")}
        defaultValue="technical"
        required
        options={SUPPORT_CATEGORY_VALUES.map((value) => ({
          value,
          label: t(`form.category.${value}`),
        }))}
        {...invalid("category")}
      />
      {resources.length > 0 ? (
        <div className="mb-3">
          <label className="seccolor" htmlFor={relatedId}>
            {t("form.related.label")}
          </label>
          <select className="form-select" id={relatedId} name="relatedResourceId" defaultValue="">
            <option value="">{t("form.related.none")}</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="seccolor small mb-0">{t("form.related.hint")}</p>
        </div>
      ) : null}
      <Field
        name="subject"
        label={t("form.subject.label")}
        hint={t("form.subject.hint")}
        icon="fas fa-file-alt"
        required
        maxLength={120}
        autoComplete="off"
        {...invalid("subject")}
      />
      <Field
        name="message"
        label={t("form.message.label")}
        hint={t("form.message.hint")}
        multiline
        rows={6}
        required
        maxLength={5000}
        {...invalid("message")}
      />
      <SubmitButton variant="primary" pending={pending} disabled={pending}>
        {pending ? t("form.working") : t("form.submit")}
      </SubmitButton>
    </form>
  );
}
