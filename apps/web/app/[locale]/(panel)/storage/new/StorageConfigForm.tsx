"use client";

import { Field, MoneyText, PlanPicker, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { BucketPlanOption } from "../../../../../server/bucket-view.ts";

// The form of /storage/new (16.10): plan and name on the left, the summary on the right
// (configurator.html, section.config). Client Component because it holds the choice of plan. Every
// price shown here was computed on the server; this file adds and rounds nothing (R4). The Region is
// the one of the chosen plan. The access setting is not a field: a new bucket is private (R16).

export function StorageConfigForm({
  plans,
  action,
}: {
  plans: BucketPlanOption[];
  /** The Server Action (createBucketDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Storage");
  const tn = useTranslations("Storage.new");
  const tf = useTranslations("Flow");
  const regions = useTranslations("Servers.region");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen = plans.find((plan) => plan.id === chosenId) ?? (plans[0] as BucketPlanOption);

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const planName = (plan: BucketPlanOption): string =>
    plan.storageGb === undefined ? t("plan.generic") : t("plan.storage", { size: plan.storageGb });
  const planLines = (plan: BucketPlanOption): string[] => [
    ...(plan.transferGb === undefined ? [] : [t("plan.transfer", { size: plan.transferGb })]),
    regions.has(plan.region) ? regions(plan.region) : plan.region,
  ];

  return (
    <form action={formAction} className="config" noValidate>
      {topError !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {topError}
        </div>
      ) : null}
      <input type="hidden" name="region" value={chosen.region} />
      <div className="row">
        <div className="col-lg-8">
          <PlanPicker
            name="productId"
            legend={tn("planLegend")}
            plans={plans.map((plan) => ({
              id: plan.id,
              name: planName(plan),
              priceMinor: plan.priceMinor,
              lines: planLines(plan),
            }))}
            value={chosen.id}
            onChange={setChosenId}
          />
          {fieldError("productId") !== undefined ? (
            <p className="tc-field-error" role="alert">
              {fieldError("productId")}
            </p>
          ) : null}

          <p className="seccolor">{tn("accessNote")}</p>

          <Field
            name="displayName"
            label={tn("step.name")}
            hint={tn("nameHint")}
            placeholder={tn("namePlaceholder")}
            maxLength={60}
            required
            autoComplete="off"
            {...(fieldError("displayName") !== undefined
              ? { error: fieldError("displayName") as string }
              : {})}
          />
          <p className="form-text seccolor">{tn("bucketNameNote")}</p>
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={tn("summary.title")}
            planTitle={planName(chosen)}
            planLines={planLines(chosen)}
            rows={[
              { label: tn("summary.access"), value: tn("summary.accessValue") },
              { label: tn("summary.term"), value: tn("summary.termValue") },
              {
                label: tn("summary.price"),
                value: <MoneyText minor={chosen.priceMinor} mode="exact" />,
                strong: true,
              },
            ]}
            action={
              <SubmitButton variant="primary" className="w-100">
                {tn("submit")}
              </SubmitButton>
            }
          />
        </div>
      </div>
    </form>
  );
}
