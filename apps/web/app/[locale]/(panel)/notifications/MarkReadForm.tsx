"use client";

import { SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { FormState } from "../../../../server/action-state.ts";
import { ActionNotice } from "../servers/[id]/ExtrasForms.tsx";

/** The button "mark all as read" (U8: inert while its action runs). */
export function MarkReadForm({
  action,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Notifications");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} className="mb-3">
      <ActionNotice state={state} />
      <SubmitButton variant="default" icon="fas fa-check-double">
        {t("markAll")}
      </SubmitButton>
    </form>
  );
}
