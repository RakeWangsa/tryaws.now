"use client";

import { Button, Field, SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { FreshSignInLink } from "../../_family/FreshSignInLink.tsx";

// The forms of the DNS record editor (WPU-G4, U8): field errors come from the server's own check (the
// codes of packages/core/dns), a button is inert while its action runs, and every form carries the
// request id that the page made (R7). Nothing the customer typed is repeated in an error.

export type DnsAction = (previous: FormState, form: FormData) => Promise<FormState>;

/** The record types the editor offers. The apex NS and SOA are read-only and never offered. */
export const EDITOR_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"] as const;

export interface EditingRecord {
  relative: string;
  type: string;
  ttl: number;
  values: string[];
}

function Notice({ state, onDone }: { state: FormState; onDone?: () => void }) {
  const t = useTranslations("Dns");
  const router = useRouter();
  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
      onDone?.();
    }
    // `onDone` is a new function on each render of the parent; the result is what triggers this.
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
        <FreshSignInLink error={state.error} />
      </div>
    );
  }
  if (state.done !== undefined && t.has(`detail.done.${state.done}`)) {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {t(`detail.done.${state.done}`)}
      </div>
    );
  }
  return null;
}

/** The text of a field code, or nothing for a code that is not in the messages. */
function useFieldError(state: FormState) {
  const t = useTranslations("Dns.field");
  return (names: readonly string[]): string | undefined => {
    const fields = state.fields ?? {};
    const key = Object.keys(fields).find((k) =>
      names.some((n) => k === n || k.startsWith(`${n}.`)),
    );
    if (key === undefined) return undefined;
    const code = fields[key] as string;
    return t.has(code) ? t(code) : t("invalid_value");
  };
}

export function RecordForm({
  action,
  zoneId,
  requestId,
  editing,
  cancelHref,
}: {
  action: DnsAction;
  zoneId: string;
  requestId: string;
  editing: EditingRecord | null;
  cancelHref: string;
}) {
  const t = useTranslations("Dns.detail.form");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const error = useFieldError(state);
  const [type, setType] = useState<string>(editing?.type ?? "A");
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const hint = (EDITOR_TYPES as readonly string[]).includes(type)
    ? t(`typeHint.${type}`)
    : undefined;
  const typeError = error(["type"]);
  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="mt-4"
      aria-labelledby="dns-record-form-title"
    >
      <h3 className="mergecolor h4" id="dns-record-form-title">
        {editing === null ? t("addTitle") : t("editTitle")}
      </h3>
      <input type="hidden" name="zoneId" value={zoneId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="mode" value={editing === null ? "create" : "upsert"} />
      {editing === null ? (
        <>
          <Field
            name="name"
            label={t("name")}
            hint={t("nameHint")}
            maxLength={255}
            autoComplete="off"
            required
            {...(error(["name"]) !== undefined ? { error: error(["name"]) as string } : {})}
          />
          <div className="mb-3">
            <label className="form-label" htmlFor="dns-record-type">
              {t("type")}
            </label>
            <select
              className="form-select"
              id="dns-record-type"
              name="type"
              value={type}
              onChange={(event) => setType(event.target.value)}
              aria-invalid={typeError !== undefined ? true : undefined}
            >
              {EDITOR_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            {typeError !== undefined ? (
              <p className="tc-field-error" role="alert">
                {typeError}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <input type="hidden" name="name" value={editing.relative} />
          <input type="hidden" name="type" value={editing.type} />
          <p className="seccolor">
            <b className="mergecolor">{editing.relative}</b> · {editing.type}
          </p>
        </>
      )}
      <Field
        name="ttl"
        label={t("ttl")}
        hint={t("ttlHint")}
        inputMode="numeric"
        maxLength={6}
        autoComplete="off"
        required
        defaultValue={String(editing?.ttl ?? 300)}
        {...(error(["ttl"]) !== undefined ? { error: error(["ttl"]) as string } : {})}
      />
      <Field
        name="values"
        label={t("values")}
        hint={[t("valuesHint"), hint].filter(Boolean).join(" ")}
        multiline
        rows={4}
        autoComplete="off"
        required
        defaultValue={editing === null ? "" : editing.values.join("\n")}
        {...(error(["values"]) !== undefined ? { error: error(["values"]) as string } : {})}
      />
      <Notice
        state={state}
        onDone={() => {
          formRef.current?.reset();
          if (editing !== null) router.replace(cancelHref);
        }}
      />
      <div className="d-flex flex-wrap gap-2">
        <SubmitButton variant="primary">
          {editing === null ? t("submitAdd") : t("submitEdit")}
        </SubmitButton>
        {editing === null ? null : (
          <Button variant="default" href={cancelHref}>
            {t("cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

export function DeleteRecordForm({
  action,
  zoneId,
  requestId,
  relative,
  type,
  label,
  buttonText,
}: {
  action: DnsAction;
  zoneId: string;
  requestId: string;
  relative: string;
  type: string;
  label: string;
  buttonText: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="zoneId" value={zoneId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="name" value={relative} />
      <input type="hidden" name="type" value={type} />
      <SubmitButton variant="destructive" size="sm" aria-label={label} icon="fas fa-trash-alt">
        {buttonText}
      </SubmitButton>
      <Notice state={state} />
    </form>
  );
}
