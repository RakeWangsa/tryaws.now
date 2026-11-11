"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { ReactNode } from "react";
import { SubmitButton } from "@tc/ui";
import type { FieldCode } from "@tc/core";
import type { FormState } from "../../../../server/auth/state.ts";
import { AuthErrorAlert } from "./AuthAlert.tsx";

export interface FormChildState {
  fields: Record<string, FieldCode>;
  values: Record<string, string>;
  /** The translated message of a field error, or undefined (U8: the same parser as the action). */
  error: (name: string) => string | undefined;
}

export interface AuthFormViewProps {
  state: FormState;
  action: (data: FormData) => void;
  hidden: Record<string, string>;
  /** Without a label there is no submit button of the form itself (the children bring their own). */
  submitLabel?: string;
  submitIcon?: string;
  /** Shown inside the failure alert for `sign_in_failed`, such as the link to /verify. */
  failureExtra?: ReactNode;
  /** Next to the submit button, such as the "forgot password" link of login.html. */
  afterSubmit?: ReactNode;
  children: (s: FormChildState) => ReactNode;
}

/** The presentation of a form in a state. Pure, so the tests can render every state. */
export function AuthFormView({
  state,
  action,
  hidden,
  submitLabel,
  submitIcon,
  failureExtra,
  afterSubmit,
  children,
}: AuthFormViewProps) {
  const t = useTranslations("Auth.field.error");
  const fields = state.status === "error" ? (state.fields ?? {}) : {};
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const error = (name: string): string | undefined => {
    const code = fields[name];
    return code === undefined ? undefined : t(code, { min: 12 });
  };
  return (
    <form action={action}>
      {state.status === "error" ? (
        <AuthErrorAlert
          code={state.code}
          reference={state.ref}
          {...(state.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: state.retryAfterSeconds }
            : {})}
          {...(state.code === "sign_in_failed" && failureExtra !== undefined
            ? { extra: failureExtra }
            : {})}
        />
      ) : null}
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children({ fields, values, error })}
      {submitLabel !== undefined || afterSubmit !== undefined ? (
        <div className="mt-5 position-relative">
          {submitLabel !== undefined ? (
            <SubmitButton
              variant="primary"
              className="mt-0 mb-3 me-3"
              {...(submitIcon !== undefined ? { icon: submitIcon } : {})}
            >
              {submitLabel}
            </SubmitButton>
          ) : null}
          {afterSubmit}
        </div>
      ) : null}
    </form>
  );
}

/**
 * A form that posts to a Server Action (U8). It holds interaction state only: the state of the last
 * answer and the pending flag of the submit button (inert while the action runs).
 */
export function AuthForm({
  action,
  ...rest
}: Omit<AuthFormViewProps, "state" | "action"> & {
  action: (prev: FormState, data: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, { status: "idle" } as FormState);
  return <AuthFormView state={state} action={formAction} {...rest} />;
}
