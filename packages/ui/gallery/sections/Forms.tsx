import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Badge, StateBadge, type BadgeTone } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { CopyField } from "../../components/CopyField.tsx";
import { Field, FormBlock } from "../../components/Field.tsx";
import { SecretReveal } from "../../components/SecretReveal.tsx";
import { SubmitButton } from "../../components/SubmitButton.tsx";
import { DEMO_IP, DEMO_SECRET, DEMO_STATES } from "../data.ts";
import { Sample } from "../Sample.tsx";

const TONES: readonly BadgeTone[] = ["purple", "grey", "pink", "dark"];

export function Forms(): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <>
      <Sample name="Field" titleKey="Gallery.samples.field">
        <FormBlock>
          <div className="row">
            <div className="col-md-6">
              <Field name="demo-plain" label={t("field.label")} hint={t("field.hint")} />
              <Field name="demo-optional" label={t("field.optionalLabel")} optional />
            </div>
            <div className="col-md-6">
              <Field
                name="demo-error"
                label={t("field.errorLabel")}
                error={t("field.error")}
                defaultValue=""
              />
            </div>
          </div>
        </FormBlock>
      </Sample>
      <Sample name="FormBlock" titleKey="Gallery.samples.formBlock">
        <FormBlock>
          <Field name="demo-email" type="email" label={t("field.email")} icon="fas fa-envelope" />
          <Field
            name="demo-password"
            type="password"
            label={t("field.password")}
            icon="fas fa-lock"
            autoComplete="off"
          />
        </FormBlock>
      </Sample>
      <Sample name="Badge" titleKey="Gallery.samples.badge">
        <div className="d-flex flex-wrap gap-2">
          {TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {t("badge.tone")}
            </Badge>
          ))}
        </div>
      </Sample>
      <Sample name="StateBadge" titleKey="Gallery.samples.stateBadge">
        <div className="d-flex flex-wrap gap-2">
          {DEMO_STATES.map((state) => (
            <StateBadge key={state} state={state} />
          ))}
        </div>
      </Sample>
      <Sample name="Button" titleKey="Gallery.samples.button">
        <div className="d-flex flex-wrap gap-2">
          <Button variant="primary">{t("button.primary")}</Button>
          <Button variant="secondary">{t("button.secondary")}</Button>
          <Button variant="tertiary">{t("button.tertiary")}</Button>
          <Button variant="destructive">{t("button.destructive")}</Button>
          <Button variant="primary" pending>
            {t("button.pending")}
          </Button>
        </div>
      </Sample>
      <Sample name="SubmitButton" titleKey="Gallery.samples.submitButton">
        <SubmitButton>{t("button.submit")}</SubmitButton>
      </Sample>
      <Sample name="SecretReveal" titleKey="Gallery.samples.secretReveal">
        <SecretReveal label={t("secret.label")} secret={DEMO_SECRET} />
      </Sample>
      <Sample name="CopyField" titleKey="Gallery.samples.copyField">
        <FormBlock>
          <CopyField label={t("copy.label")} value={DEMO_IP} hint={t("copy.hint")} />
        </FormBlock>
      </Sample>
    </>
  );
}
