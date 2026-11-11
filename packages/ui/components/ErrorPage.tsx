import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export interface ErrorPageProps {
  title: string;
  /** A platform message. Never raw AWS or EPS text. */
  message: string;
  referenceId?: string;
  retry?: ReactNode;
  home?: ReactNode;
}

/** A malformed id could carry raw error text, so only a plain token is shown (R14, R16). */
const REFERENCE_ID = /^[A-Za-z0-9_-]{6,64}$/;

export function ErrorPage({ title, message, referenceId, retry, home }: ErrorPageProps) {
  const t = useTranslations("kit.states");
  const showReference = referenceId !== undefined && REFERENCE_ID.test(referenceId);
  return (
    <div className="tc-error text-center" role="alert">
      <i className="fas fa-exclamation-triangle" aria-hidden="true" />
      <h2 className="h4 mergecolor">{title}</h2>
      <p className="seccolor">{message}</p>
      {showReference ? <p className="small c-grey">{t("reference", { id: referenceId })}</p> : null}
      {retry}
      {home}
    </div>
  );
}
