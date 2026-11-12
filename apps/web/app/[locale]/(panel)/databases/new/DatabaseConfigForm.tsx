"use client";

import { Field, MoneyText, PlanPicker, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DatabasePlanOption } from "../../../../../server/databases-view.ts";
import { useRegionLabel, useSpecLine } from "../../servers/ServerParts.tsx";
import { useEngineLabel } from "../DatabaseParts.tsx";

// The form of /databases/new (16.10): option groups on the left, the summary on the right
// (configurator.html, section.config). Client Component because it holds the choice of Region and
// plan. Every price shown here was computed on the server; this file adds and rounds nothing (R4).
// The plan decides the engine, the version and the size; the form sends the plan, the Region and the
// name, and nothing about a password or public access (R11, U9).

export function DatabaseConfigForm({
  plans,
  regions,
  action,
}: {
  plans: DatabasePlanOption[];
  regions: string[];
  /** The Server Action (createDatabaseDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Databases.new");
  const tf = useTranslations("Flow");
  const specLine = useSpecLine();
  const engineLabel = useEngineLabel();
  const regionLabel = useRegionLabel();
  const base = useId();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const [region, setRegion] = useState(regions[0] as string);
  const inRegion = plans.filter((plan) => plan.region === region);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen =
    inRegion.find((plan) => plan.id === chosenId) ?? (inRegion[0] as DatabasePlanOption);

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const planName = (plan: DatabasePlanOption): string =>
    engineLabel(plan.specs) ?? (specLine({ vcpus: plan.specs.vcpus }) || specLine(plan.specs));
  const planLines = (plan: DatabasePlanOption): string[] =>
    [
      specLine({
        vcpus: plan.specs.vcpus,
        ramGb: plan.specs.ramGb,
        diskGb: plan.specs.diskGb,
        transferGb: plan.specs.transferGb,
      }),
    ].filter((line) => line !== "");

  return (
    <form action={formAction} className="config" noValidate>
      {topError !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {topError}
        </div>
      ) : null}
      <div className="row">
        <div className="col-lg-8">
          <div className="cd-filter-block">
            <fieldset>
              <legend className="seccolor h6 mb-4">{t("step.location")}</legend>
              <ul className="radio-group radios-filter cd-filter-content list">
                {regions.map((code, index) => (
                  <li key={code}>
                    <input
                      type="radio"
                      id={`${base}-r${index}`}
                      name="region"
                      value={code}
                      checked={code === region}
                      onChange={() => {
                        setRegion(code);
                        setChosenId(undefined);
                      }}
                    />
                    <label className="radio-label seccolor" htmlFor={`${base}-r${index}`}>
                      {regionLabel(code)}
                    </label>
                  </li>
                ))}
              </ul>
              <p className="form-text seccolor">{t("locationHint")}</p>
            </fieldset>
          </div>

          <PlanPicker
            name="productId"
            legend={t("step.plan")}
            plans={inRegion.map((plan) => ({
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

          <Field
            name="displayName"
            label={t("step.name")}
            hint={t("nameHint")}
            placeholder={t("namePlaceholder")}
            maxLength={60}
            required
            autoComplete="off"
            {...(fieldError("displayName") !== undefined
              ? { error: fieldError("displayName") as string }
              : {})}
          />
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={t("summary.title")}
            planTitle={planName(chosen)}
            planLines={planLines(chosen)}
            rows={[
              { label: t("summary.location"), value: regionLabel(region) },
              { label: t("summary.access"), value: t("summary.accessValue") },
              { label: t("summary.term"), value: t("summary.termValue") },
              {
                label: t("summary.price"),
                value: <MoneyText minor={chosen.priceMinor} mode="exact" />,
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
