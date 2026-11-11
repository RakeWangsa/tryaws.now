"use client";

import { Field, MoneyText, OptionGroup, PlanPicker, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type {
  LoadBalancerPlanOption,
  TargetServer,
} from "../../../../../server/load-balancers-view.ts";
import { useRegionLabel } from "../../servers/ServerParts.tsx";

// The form of /load-balancers/new (16.10): option groups on the left, the summary on the right
// (configurator.html, section.config). Client Component because it holds the choice of Region and
// plan, which decides which of the customer's servers can be a target (the same Region, 10.3). Every
// price shown here was computed on the server; this file adds and rounds nothing (R4). The ids sent
// as targets are only checked again on the server through the scoped repository (R8).

export function LoadBalancerConfigForm({
  plans,
  servers,
  action,
}: {
  plans: LoadBalancerPlanOption[];
  servers: TargetServer[];
  /** The Server Action (createLoadBalancerDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("LoadBalancers.new");
  const tf = useTranslations("Flow");
  const regionLabel = useRegionLabel();
  const base = useId();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const regions = [...new Set(plans.map((plan) => plan.region))];
  const [region, setRegion] = useState(regions[0] as string);
  const inRegion = plans.filter((plan) => plan.region === region);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen =
    inRegion.find((plan) => plan.id === chosenId) ?? (inRegion[0] as LoadBalancerPlanOption);
  const targets = servers.filter((server) => server.region === region);
  const [picked, setPicked] = useState(0);

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;

  return (
    <form
      action={formAction}
      className="config"
      noValidate
      onChange={(event) => {
        // The option groups keep no state; the form reads its own fields for the summary.
        setPicked(new FormData(event.currentTarget).getAll("targetIds").length);
      }}
    >
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
                        setPicked(0);
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
            legend={t("planLegend")}
            plans={inRegion.map((plan) => ({
              id: plan.id,
              name: t("planName"),
              priceMinor: plan.priceMinor,
              lines: [t("planLine")],
            }))}
            value={chosen.id}
            onChange={setChosenId}
          />
          {fieldError("productId") !== undefined ? (
            <p className="tc-field-error" role="alert">
              {fieldError("productId")}
            </p>
          ) : null}

          {targets.length === 0 ? (
            <div className="cd-filter-block">
              <p className="seccolor h6 mb-3">{t("step.targets")}</p>
              <p className="seccolor">{t("noTargetsInRegion")}</p>
              {fieldError("targetIds") !== undefined ? (
                <p className="tc-field-error" role="alert">
                  {fieldError("targetIds")}
                </p>
              ) : null}
            </div>
          ) : (
            <OptionGroup
              key={region}
              kind="checkbox"
              name="targetIds"
              legend={t("step.targets")}
              options={targets.map((server) => ({
                value: server.id,
                label: server.name === "" ? server.id.slice(0, 8) : server.name,
              }))}
              hint={t("targetsHint")}
              {...(fieldError("targetIds") !== undefined
                ? { error: fieldError("targetIds") as string }
                : {})}
            />
          )}

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
          <p className="form-text seccolor">{t("httpNote")}</p>
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={t("summary.title")}
            planTitle={t("planName")}
            planLines={[t("planLine")]}
            rows={[
              { label: t("summary.location"), value: regionLabel(region) },
              { label: t("summary.targets"), value: String(picked) },
              { label: t("summary.term"), value: t("summary.termValue") },
              {
                label: t("summary.price"),
                value: <MoneyText minor={chosen.priceMinor} mode="exact" />,
                strong: true,
              },
            ]}
            action={
              <SubmitButton variant="primary" className="w-100" disabled={targets.length === 0}>
                {t("submit")}
              </SubmitButton>
            }
          />
        </div>
      </div>
    </form>
  );
}
