"use client";

import { Field, MoneyText, OptionGroup, PlanPicker, SubmitButton, SummarySidebar } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { CdnPlanOption, OriginOption } from "../../../../../server/cdn-view.ts";

// The form of /cdn/new (16.10): option groups on the left, the summary on the right (configurator.html,
// section.config). Client Component because it holds the choice of plan and origin. Every price shown
// here was computed on the server; this file adds and rounds nothing (R4). The Region is the one of the
// chosen plan: a CDN is global, so the customer is not asked for one.

export function CdnConfigForm({
  plans,
  origins,
  action,
}: {
  plans: CdnPlanOption[];
  origins: OriginOption[];
  /** The Server Action (createCdnDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Cdn");
  const tn = useTranslations("Cdn.new");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen = plans.find((plan) => plan.id === chosenId) ?? (plans[0] as CdnPlanOption);
  const [originId, setOriginId] = useState((origins[0] as OriginOption).id);
  const origin = origins.find((o) => o.id === originId) ?? (origins[0] as OriginOption);
  const [cache, setCache] = useState<"cache" | "dont-cache">("cache");

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;
  const planName = (plan: CdnPlanOption): string => t(`plan.${planWord(plan.bundle)}`);
  const originText = (o: OriginOption): string =>
    o.name === "" ? t(`origin.${o.kind}`) : `${t(`origin.${o.kind}`)}: ${o.name}`;

  return (
    <form
      action={formAction}
      className="config"
      noValidate
      onChange={(event) => {
        // The option groups keep no state; the form reads its own fields for the summary.
        const data = new FormData(event.currentTarget);
        const o = data.get("originId");
        const c = data.get("cacheBehavior");
        if (typeof o === "string") setOriginId(o);
        if (c === "cache" || c === "dont-cache") setCache(c);
      }}
    >
      {topError !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {topError}
        </div>
      ) : null}
      <input type="hidden" name="region" value={chosen.region} />
      <div className="row">
        <div className="col-lg-8">
          <div className="cd-filter-block">
            <OptionGroup
              kind="select"
              name="originId"
              legend={tn("step.origin")}
              options={origins.map((o) => ({ value: o.id, label: originText(o) }))}
              defaultValue={originId}
              hint={tn("originHint")}
              required
              {...(fieldError("originId") !== undefined
                ? { error: fieldError("originId") as string }
                : {})}
            />
          </div>

          <PlanPicker
            name="productId"
            legend={tn("planLegend")}
            plans={plans.map((plan) => ({
              id: plan.id,
              name: planName(plan),
              priceMinor: plan.priceMinor,
              lines:
                plan.transferGb === undefined
                  ? []
                  : [t("plan.transfer", { size: plan.transferGb })],
            }))}
            value={chosen.id}
            onChange={setChosenId}
          />
          {fieldError("productId") !== undefined ? (
            <p className="tc-field-error" role="alert">
              {fieldError("productId")}
            </p>
          ) : null}

          <OptionGroup
            kind="radio"
            name="cacheBehavior"
            legend={tn("step.cache")}
            options={[
              { value: "cache", label: t("cache.cache") },
              { value: "dont-cache", label: t("cache.dont-cache") },
            ]}
            defaultValue={cache}
            hint={tn("cacheHint")}
            {...(fieldError("cacheBehavior") !== undefined
              ? { error: fieldError("cacheBehavior") as string }
              : {})}
          />

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
          <p className="form-text seccolor">{tn("customDomainNote")}</p>
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={tn("summary.title")}
            planTitle={planName(chosen)}
            planLines={
              chosen.transferGb === undefined
                ? []
                : [t("plan.transfer", { size: chosen.transferGb })]
            }
            rows={[
              { label: tn("summary.origin"), value: originText(origin) },
              { label: tn("summary.cache"), value: t(`cache.${cache}`) },
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

function planWord(bundle: CdnPlanOption["bundle"]): "small" | "medium" | "large" {
  return bundle === "small_1_0" ? "small" : bundle === "medium_1_0" ? "medium" : "large";
}
