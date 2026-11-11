"use client";

import { Field, OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";
import type { StartKycResult, SubmitKycResult } from "../../../../server/kyc-actions.ts";

// The form of /kyc (16.9): account type, identity details, document images, then send. The browser
// checks size and type for a quick answer; the upload policy and the server check them again. The
// images go straight to the object store by the presigned POST, never through this app. This file
// imports nothing from @tc/core (the page passes the limits), so the client bundle stays small.

export interface KycLimits {
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
  readonly maxFiles: number;
  readonly documents: Readonly<Record<"individual" | "business", readonly string[]>>;
}

type StartAction = (input: unknown) => Promise<StartKycResult>;
type SubmitAction = (input: unknown) => Promise<SubmitKycResult>;

/** Pure: the key of the first problem with the chosen files, or null. Exported for the tests. */
export function checkFiles(
  files: readonly { type: string; size: number }[],
  limits: Pick<KycLimits, "maxBytes" | "contentTypes" | "maxFiles">,
): "required" | "wrongType" | "tooBig" | null {
  if (files.length < 1 || files.length > limits.maxFiles) return "required";
  for (const file of files) {
    if (!limits.contentTypes.includes(file.type)) return "wrongType";
    if (file.size < 1 || file.size > limits.maxBytes) return "tooBig";
  }
  return null;
}

export function KycForm({
  limits,
  defaultType,
  startAction,
  submitAction,
}: {
  limits: KycLimits;
  defaultType: "individual" | "business" | null;
  startAction: StartAction;
  submitAction: SubmitAction;
}) {
  const t = useTranslations("Kyc");
  const [type, setType] = useState<"individual" | "business">(defaultType ?? "individual");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({});
  const [done, setDone] = useState(false);

  const fail = (key: string, with_?: Record<string, string>): void => {
    setError(key);
    setFields(with_ ?? {});
    setPending(false);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosen = ["file0", "file1"]
      .map((name) => form.get(name))
      .filter((v): v is File => v instanceof File && v.size > 0);
    setError(null);
    setFields({});
    const problem = checkFiles(chosen, limits);
    if (problem !== null) return fail("validation", { files: problem });
    const documentType = String(form.get("documentType") ?? "");
    setPending(true);
    try {
      const started = await startAction({
        customerType: type,
        documentType,
        files: chosen.map((file) => ({ contentType: file.type, size: file.size })),
      });
      if (!started.ok) return fail(started.error, started.fields);
      for (const [index, upload] of started.uploads.entries()) {
        // The development store has no URL to post to; every real URL is https.
        if (upload.url.startsWith("fake:")) continue;
        const body = new FormData();
        for (const [name, value] of Object.entries(upload.fields)) body.append(name, value);
        body.append("file", chosen[index] as File); // the file field comes last
        const sent = await fetch(upload.url, { method: "POST", body });
        if (!sent.ok) return fail("upload_failed", { files: "failed" });
      }
      const submitted = await submitAction({
        submissionId: started.submissionId,
        customerType: type,
        documentType,
        documentNumber: String(form.get("documentNumber") ?? ""),
        fileTypes: chosen.map((file) => file.type),
      });
      if (!submitted.ok) return fail(submitted.error, submitted.fields);
      setDone(true);
      setPending(false);
    } catch {
      fail("unavailable");
    }
  }

  const fileError = (): string | undefined => {
    const key = fields["files"];
    if (key === undefined) return undefined;
    return key === "failed"
      ? t("form.files.failed")
      : key === "tooBig" || key === "wrongType" || key === "required"
        ? t(`form.files.${key}`)
        : t("field.invalid");
  };
  const fieldError = (name: string): string | undefined =>
    fields[name] !== undefined ? t("field.invalid") : undefined;
  const documents = limits.documents[type];

  return (
    <form onSubmit={onSubmit} noValidate>
      {error !== null && error !== "upload_failed" ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`) ? t(`error.${error}`) : t("error.unavailable")}
        </div>
      ) : null}
      {done ? (
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-check-circle me-2" aria-hidden="true" />
          {t("done")}
        </div>
      ) : null}

      <h3 className="h5 mergecolor mb-3">{t("form.accountTitle")}</h3>
      <div
        onChange={(event) => {
          const value = (event.target as HTMLInputElement).value;
          if (value === "individual" || value === "business") setType(value);
        }}
      >
        <OptionGroup
          kind="radio"
          name="customerType"
          legend={t("form.type.legend")}
          defaultValue={type}
          options={[
            { value: "individual", label: t("form.type.individual") },
            { value: "business", label: t("form.type.business") },
          ]}
        />
      </div>

      <h3 className="h5 mergecolor mt-4 mb-3">{t("form.detailsTitle")}</h3>
      <OptionGroup
        key={type}
        kind="radio"
        name="documentType"
        legend={t("form.document.legend")}
        defaultValue={documents[0]}
        required
        options={documents.map((value) => ({ value, label: t(`form.document.${value}`) }))}
        {...(fieldError("documentType") !== undefined
          ? { error: fieldError("documentType") as string }
          : {})}
      />
      <Field
        name="documentNumber"
        label={t("form.number.label")}
        hint={t("form.number.hint")}
        required
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        {...(fieldError("documentNumber") !== undefined
          ? { error: fieldError("documentNumber") as string }
          : {})}
      />

      <h3 className="h5 mergecolor mt-4 mb-3">{t("form.uploadTitle")}</h3>
      {(["file0", "file1"] as const).map((name, index) => (
        <div key={name} className="position-relative mb-3">
          <label className="seccolor" htmlFor={`kyc-${name}`}>
            {index === 0 ? t("form.files.front") : t("form.files.back")}
          </label>
          <input
            id={`kyc-${name}`}
            name={name}
            type="file"
            className="form-control"
            accept={limits.contentTypes.join(",")}
            aria-invalid={index === 0 && fileError() !== undefined ? true : undefined}
          />
        </div>
      ))}
      <p className="form-text seccolor">{t("form.files.hint")}</p>
      {fileError() !== undefined ? (
        <p className="tc-field-error" role="alert">
          <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
          {fileError()}
        </p>
      ) : null}

      <p className="seccolor small mt-3">{t("privacy")}</p>
      <SubmitButton variant="primary" pending={pending} disabled={pending || done}>
        {pending ? t("form.working") : t("form.submit")}
      </SubmitButton>
    </form>
  );
}
