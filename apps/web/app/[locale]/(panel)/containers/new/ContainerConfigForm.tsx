"use client";

import { Field, MoneyText, PlanPicker, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { ContainerPlanOption } from "../../../../../server/container-view.ts";

// The form of /containers/new (16.10): power and scale on the left, the summary on the right
// (configurator.html, section.config). Client Component because it holds the choice of plan. Every
// price shown here was computed on the server; this file adds and rounds nothing (R4). Power and scale
// are the ones of the chosen catalog row; the form posts the plan id, not a number of them. The image
// is not asked here: it is started from the page of the service after the purchase.

export function ContainerConfigForm({
  plans,
  action,
}: {
  plans: ContainerPlanOption[];
  /** The Server Action (createContainerDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Containers");
  const tn = useTranslations("Containers.new");
  const tf = useTranslations("Flow");
  const regions = useTranslations("Servers.region");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen = plans.find((plan) => plan.id === chosenId) ?? (plans[0] as ContainerPlanOption);

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const planName = (plan: ContainerPlanOption): string => t(`power.${plan.power}`);
  const planLines = (plan: ContainerPlanOption): string[] => [
    t("plan.scale", { count: plan.scale }),
    ...(plan.vcpus === undefined ? [] : [t("plan.vcpu", { count: plan.vcpus })]),
    ...(plan.ramGb === undefined ? [] : [t("plan.ram", { size: plan.ramGb })]),
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
          <p className="form-text seccolor">{tn("urlNote")}</p>
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={tn("summary.title")}
            planTitle={planName(chosen)}
            planLines={planLines(chosen)}
            rows={[
              { label: tn("summary.power"), value: planName(chosen) },
              { label: tn("summary.scale"), value: String(chosen.scale) },
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
