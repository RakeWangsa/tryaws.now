"use client";

import { Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import { ConsoleNotice, Hidden, fieldError } from "./ConsoleForms.tsx";
import type { ConsoleAction } from "./ConsoleForms.tsx";

// Remove or replace the certificate of a custom domain (WPU-G11), on the container service, CDN and
// load balancer pages. Both actions take the working HTTPS of the domain away, so each one asks the
// customer to type the domain of the certificate; the server also asks for a fresh sign-in (U10) and
// checks everything again (R9). Each form has its own request id (R7). U8: a button is inert while its
// action runs. U11: a result is a text.

export function CertificateChange({
  removeAction,
  replaceAction,
  idField,
  resourceId,
  removeRequestId,
  replaceRequestId,
  domain,
  allowed,
  loadBalancer = false,
}: {
  removeAction: ConsoleAction;
  replaceAction: ConsoleAction;
  idField: "containerId" | "cdnId" | "loadBalancerId";
  resourceId: string;
  removeRequestId: string;
  replaceRequestId: string;
  /** The domain of the saved certificate: the text that has to be typed. */
  domain: string;
  allowed: boolean;
  /** A load balancer turns its HTTPS redirect off when the certificate goes. */
  loadBalancer?: boolean;
}) {
  const t = useTranslations("Console.cert.change");
  const tc = useTranslations("Console");
  const [replaceState, replaceForm] = useActionState(replaceAction, INITIAL_FORM_STATE);
  const [removeState, removeForm] = useActionState(removeAction, INITIAL_FORM_STATE);
  const invalid = tc("field.invalid");
  return (
    <>
      <h4 className="mergecolor h5">{t("title")}</h4>
      <p className="seccolor">{t("intro")}</p>
      {loadBalancer ? <p className="seccolor">{t("lbNote")}</p> : null}

      <form action={replaceForm} noValidate className="mb-4">
        <Hidden idField={idField} id={resourceId} requestId={replaceRequestId} />
        <h5 className="mergecolor h6">{t("replaceTitle")}</h5>
        <p className="seccolor">{t("replaceIntro")}</p>
        <ConsoleNotice state={replaceState} />
        <Field
          name="domain"
          label={t("newDomain")}
          hint={t("newDomainHint")}
          maxLength={253}
          autoComplete="off"
          required
          disabled={!allowed}
          {...fieldError(replaceState, "domain", invalid)}
        />
        <Field
          name="confirmName"
          label={t("typeLabel", { domain })}
          maxLength={253}
          autoComplete="off"
          required
          disabled={!allowed}
          {...(replaceState.error === "name_mismatch" ? { error: tc("error.name_mismatch") } : {})}
        />
        <SubmitButton variant="primary" disabled={!allowed}>
          {t("replaceSubmit")}
        </SubmitButton>
      </form>

      <form action={removeForm} noValidate className="mb-4">
        <Hidden idField={idField} id={resourceId} requestId={removeRequestId} />
        <h5 className="mergecolor h6">{t("removeTitle")}</h5>
        <p className="seccolor">{t("removeIntro")}</p>
        <ConsoleNotice state={removeState} />
        <Field
          name="confirmName"
          label={t("typeLabel", { domain })}
          maxLength={253}
          autoComplete="off"
          required
          disabled={!allowed}
          {...(removeState.error === "name_mismatch" ? { error: tc("error.name_mismatch") } : {})}
        />
        <SubmitButton variant="default" icon="fas fa-trash" disabled={!allowed}>
          {t("removeSubmit")}
        </SubmitButton>
      </form>
    </>
  );
}
