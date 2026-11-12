"use client";

import { Field, MoneyText, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DiskRestoreOption } from "../../../../../server/disk-restore-view.ts";
import { useRegionLabel } from "../ServerParts.tsx";

// The form of /servers/disk-restore (WPU-X2). It posts to restoreDiskAction, which makes the signed
// draft and sends the customer to the review page, where the total is shown and the purchase (with its
// idempotency key, R7) writes the operation row (R1). Here only the ids of the chosen snapshot and of
// its anchor row, the Region and the typed name and size are sent: the name is customer text and never
// becomes an AWS name (R11); the server checks the snapshot against the customer's own rows (R8). The
// per-GB price was computed on the server in paisa; this file adds and rounds nothing (R4).

export type DiskRestoreAction = (previous: FormState, form: FormData) => Promise<FormState>;

export function DiskRestoreForm({
  options,
  action,
}: {
  options: DiskRestoreOption[];
  action: DiskRestoreAction;
}) {
  const t = useTranslations("DiskRestore");
  const te = useTranslations("Extras");
  const tf = useTranslations("Flow");
  const regionLabel = useRegionLabel();
  const base = useId();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [chosenId, setChosenId] = useState(options[0]?.snapshotId ?? "");
  const chosen =
    options.find((o) => o.snapshotId === chosenId) ?? (options[0] as DiskRestoreOption);
  const limits = { min: chosen.minGb, max: chosen.maxGb };
  const error = state.error;
  const fields = state.fields ?? {};
  const label = (o: DiskRestoreOption): string =>
    t("snapshotOption", {
      name: o.name !== "" ? o.name : o.sourceDestroyed ? t("sourceDestroyed") : t("unnamed"),
      location: regionLabel(o.region),
      size: o.minGb,
    });
  return (
    <form action={formAction} noValidate>
      {error === undefined ? null : (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`)
            ? t(`error.${error}`)
            : te.has(`error.${error}`)
              ? te(`error.${error}`)
              : te("error.unavailable")}
        </div>
      )}
      <input type="hidden" name="region" value={chosen.region} />
      <input type="hidden" name="productId" value={chosen.productId} />
      <div className="mb-3">
        <label className="seccolor" htmlFor={`${base}-snapshot`}>
          {t("snapshot")}
        </label>
        <select
          className="form-select"
          id={`${base}-snapshot`}
          name="restoreFromBackupId"
          value={chosenId}
          onChange={(event) => setChosenId(event.target.value)}
          aria-invalid={fields["restoreFromBackupId"] !== undefined ? true : undefined}
          aria-describedby={
            fields["restoreFromBackupId"] !== undefined ? `${base}-snapshot-error` : undefined
          }
        >
          {options.map((o) => (
            <option key={o.snapshotId} value={o.snapshotId}>
              {label(o)}
            </option>
          ))}
        </select>
        {fields["restoreFromBackupId"] !== undefined ? (
          <div id={`${base}-snapshot-error`} className="invalid-feedback d-block" role="alert">
            {t("snapshotInvalid")}
          </div>
        ) : null}
      </div>
      <Field
        name="displayName"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        {...(fields["displayName"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <Field
        key={chosen.snapshotId}
        name="sizeGb"
        label={t("size")}
        hint={t("sizeHint", limits)}
        inputMode="numeric"
        maxLength={5}
        required
        autoComplete="off"
        defaultValue={String(chosen.minGb)}
        {...(fields["sizeGb"] !== undefined
          ? {
              error: fields["sizeGb"] === "too_small" ? t("tooSmall") : t("sizeInvalid", limits),
            }
          : {})}
      />
      {fields["region"] !== undefined ? (
        <div className="invalid-feedback d-block mb-3" role="alert">
          {t("regionInvalid")}
        </div>
      ) : null}
      {fields["productId"] !== undefined ? (
        <div className="invalid-feedback d-block mb-3" role="alert">
          {t("productInvalid")}
        </div>
      ) : null}
      <p className="seccolor mb-1">
        {t("price")}: <MoneyText minor={chosen.perGbMinor} mode="exact" />
      </p>
      <p className="seccolor">{t("priceNote")}</p>
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}
