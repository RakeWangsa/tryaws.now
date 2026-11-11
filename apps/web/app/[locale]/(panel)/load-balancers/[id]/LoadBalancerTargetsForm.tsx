"use client";

import { OptionGroup, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { FamilyNotice } from "../../_family/FamilyForms.tsx";
import type { FamilyAction } from "../../_family/FamilyForms.tsx";

// setTargets (16.10): the customer's own servers of the same Region as checkboxes, the current
// targets ticked. The ids are only a request: the core reads each one again through the scoped
// repository (R8). The page offers this form only when the action is wired (see actions.ts).

export type TargetOption = { id: string; name: string };

export function LoadBalancerTargetsForm({
  action,
  loadBalancerId,
  requestId,
  options,
  current,
}: {
  action: FamilyAction;
  loadBalancerId: string;
  requestId: string;
  options: TargetOption[];
  /** Ids of the options that are targets now. */
  current: string[];
}) {
  const t = useTranslations("LoadBalancers.detail.targets.edit");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(
    action as (p: FormState, f: FormData) => Promise<FormState>,
    INITIAL_FORM_STATE,
  );
  if (options.length === 0) return <p className="seccolor">{t("noneToAdd")}</p>;
  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="loadBalancerId" value={loadBalancerId} />
      <input type="hidden" name="requestId" value={requestId} />
      <h3 className="mergecolor h4">{t("title")}</h3>
      <FamilyNotice ns="LoadBalancers" state={state} />
      <OptionGroup
        kind="checkbox"
        name="targetIds"
        legend={t("title")}
        options={options.map((o) => ({
          value: o.id,
          label: o.name === "" ? o.id.slice(0, 8) : o.name,
        }))}
        defaultValue={current}
        hint={t("hint")}
        {...(state.fields?.["targetIds"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <SubmitButton variant="primary">{t("button")}</SubmitButton>
    </form>
  );
}
