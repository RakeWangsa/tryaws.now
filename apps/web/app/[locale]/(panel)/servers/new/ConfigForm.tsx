"use client";

import {
  Button,
  EmptyState,
  Field,
  ImageTile,
  MoneyText,
  OptionGroup,
  PlanPicker,
  SubmitButton,
  SummarySidebar,
} from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { ImageOption, KeyOption, PlanOption } from "../../../../../server/servers-view.ts";
import { useRegionLabel, useSpecLine } from "../ServerParts.tsx";

// The form of /servers/new (16.10): option groups on the left, the summary on the right
// (configurator.html, section.config). Client Component because it holds the choice of Region, image
// and plan. Every price shown here was computed on the server; this file adds and rounds nothing (R4).
// WPU-G3 and G6: like the Lightsail console, the server is made from an image the customer picks (Apps +
// OS or OS only, per Region) and an SSH key the customer owns; without a key the form says so and offers
// the key page instead of a submit button. The server checks both again (R9).

export function ConfigForm({
  locale,
  plans,
  regions,
  keys,
  images,
  action,
}: {
  locale: Locale;
  plans: PlanOption[];
  regions: string[];
  keys: KeyOption[];
  /** The offered images of each Region (the server filtered them by the admin allow-list). */
  images: Record<string, ImageOption[]>;
  /** The Server Action (createOrderDraftAction); a test passes a fake. */
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Servers.new");
  const tf = useTranslations("Flow");
  const specLine = useSpecLine();
  const regionLabel = useRegionLabel();
  const base = useId();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  const [region, setRegion] = useState(regions[0] as string);
  const inRegion = plans.filter((plan) => plan.region === region);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const chosen = inRegion.find((plan) => plan.id === chosenId) ?? (inRegion[0] as PlanOption);
  const offered = images[region] ?? [];
  const apps = offered.filter((image) => image.kind === "app");
  const operatingSystems = offered.filter((image) => image.kind === "os");
  const [imageChoice, setImageChoice] = useState<{ region: string; id: string } | undefined>(
    undefined,
  );
  // The first image of the Region until the customer picks another one in this Region.
  const imageId =
    imageChoice?.region === region && offered.some((image) => image.id === imageChoice.id)
      ? imageChoice.id
      : (operatingSystems[0] ?? apps[0])?.id;
  const image = offered.find((o) => o.id === imageId);
  const noKeys = keys.length === 0;
  const imageGroup = (list: ImageOption[], title: string) =>
    list.length === 0 ? null : (
      <div className="mb-3">
        <p className="seccolor mb-2">
          <b>{title}</b>
        </p>
        <div className="d-flex flex-wrap gap-3">
          {list.map((o) => (
            <ImageTile
              key={`${region}-${o.id}`}
              type="radio"
              name="blueprintId"
              value={o.id}
              label={o.version === null ? o.name : `${o.name} ${o.version}`}
              imageSrc={o.logo === null ? null : `/theme/assets/apps/${o.logo}.svg`}
              defaultChecked={o.id === imageId}
            />
          ))}
        </div>
      </div>
    );

  const fieldError = (name: string): string | undefined =>
    state.fields?.[name] !== undefined ? tf("field.invalid") : undefined;
  const topError =
    state.error !== undefined
      ? tf.has(`error.${state.error}`)
        ? tf(`error.${state.error}`)
        : tf("error.unavailable")
      : null;

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

          <div className="cd-filter-block">
            <fieldset>
              <legend className="seccolor h6 mb-4">{t("step.image")}</legend>
              {offered.length === 0 ? (
                <EmptyState title={t("noImages.title")} description={t("noImages.body")} />
              ) : (
                <div
                  onChange={(event) => {
                    const value = (event.target as HTMLInputElement).value;
                    setImageChoice({ region, id: value });
                  }}
                >
                  {imageGroup(apps, t("imageApps"))}
                  {imageGroup(operatingSystems, t("imageOs"))}
                </div>
              )}
              <p className="form-text seccolor">{t("imageHint")}</p>
              {image === undefined ? null : (
                <p className="form-text seccolor">
                  {image.loginUser === null
                    ? t("imageUserUnknown")
                    : t("imageUser", { user: image.loginUser })}
                </p>
              )}
            </fieldset>
          </div>
          {fieldError("blueprintId") !== undefined ? (
            <p className="tc-field-error" role="alert">
              {fieldError("blueprintId")}
            </p>
          ) : null}

          <PlanPicker
            name="productId"
            legend={t("planLegend")}
            plans={inRegion.map((plan) => ({
              id: plan.id,
              name: specLine({ vcpus: plan.specs.vcpus }) || specLine(plan.specs),
              priceMinor: plan.priceMinor,
              lines: [
                specLine({
                  ramGb: plan.specs.ramGb,
                  diskGb: plan.specs.diskGb,
                  transferGb: plan.specs.transferGb,
                }),
              ].filter((line) => line !== ""),
            }))}
            value={chosen.id}
            onChange={setChosenId}
          />
          {fieldError("productId") !== undefined ? (
            <p className="tc-field-error" role="alert">
              {fieldError("productId")}
            </p>
          ) : null}

          {noKeys ? (
            <EmptyState
              title={t("noKeys.title")}
              description={t("noKeys.body")}
              action={
                <Button variant="primary" href={localePath(locale, "/settings/ssh-keys")}>
                  {t("noKeys.action")}
                </Button>
              }
            />
          ) : (
            <>
              <OptionGroup
                kind="select"
                name="keyPairId"
                legend={t("step.key")}
                options={keys.map((key) => ({ value: key.id, label: key.name }))}
                defaultValue={(keys[0] as KeyOption).id}
                hint={`${t("keyRequired")} ${t("keyHint")}`}
                required
                {...(fieldError("keyPairId") !== undefined
                  ? { error: fieldError("keyPairId") as string }
                  : {})}
              />
              <p className="seccolor mb-4">
                <a href={localePath(locale, "/settings/ssh-keys")}>{t("keyLink")}</a>
              </p>
            </>
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
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={t("summary.title")}
            planTitle={chosen ? specLine({ vcpus: chosen.specs.vcpus }) : ""}
            planLines={[
              specLine({ ramGb: chosen.specs.ramGb, diskGb: chosen.specs.diskGb }),
            ].filter((line) => line !== "")}
            rows={[
              { label: t("summary.location"), value: regionLabel(region) },
              ...(image === undefined ? [] : [{ label: t("summary.image"), value: image.name }]),
              { label: t("summary.term"), value: t("summary.termValue") },
              {
                label: t("summary.price"),
                value: <MoneyText minor={chosen.priceMinor} mode="exact" />,
                strong: true,
              },
            ]}
            action={
              <SubmitButton
                variant="primary"
                className="w-100"
                disabled={noKeys || image === undefined}
              >
                {t("submit")}
              </SubmitButton>
            }
          />
        </div>
      </div>
    </form>
  );
}
