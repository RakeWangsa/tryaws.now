import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AuthErrorCode } from "../../../../server/auth/state.ts";

export type AlertKind = "danger" | "warning" | "info" | "success";

const ICON: Record<AlertKind, string> = {
  danger: "fas fa-exclamation-triangle",
  warning: "fas fa-exclamation-circle",
  info: "fas fa-info-circle",
  success: "fas fa-check-circle",
};

const WORD: Record<AlertKind, "error" | "warning" | "info" | "success"> = {
  danger: "error",
  warning: "warning",
  info: "info",
  success: "success",
};

/**
 * A message of the sign-in screens (U11): the alert classes of the order-form templates, an icon
 * and a word, so that the state is never shown by colour alone. Errors and warnings are announced
 * at once (`role="alert"`), the rest politely (`role="status"`).
 */
export function AuthAlert({
  kind,
  children,
  reference,
  extra,
}: {
  kind: AlertKind;
  children: ReactNode;
  /** A short reference a customer can quote. Never a secret. */
  reference?: string;
  extra?: ReactNode;
}) {
  const t = useTranslations("Auth");
  return (
    <div
      className={`alert alert-${kind} mb-4`}
      role={kind === "danger" || kind === "warning" ? "alert" : "status"}
    >
      <i className={`${ICON[kind]} me-2`} aria-hidden="true" />
      <strong>{t(`alert.${WORD[kind]}`)}</strong> {children}
      {extra !== undefined ? <div className="mt-2">{extra}</div> : null}
      {reference !== undefined ? (
        <small className="d-block mt-2">{t("error.ref", { ref: reference })}</small>
      ) : null}
    </div>
  );
}

const WARNING_CODES: readonly AuthErrorCode[] = ["rate_limited", "unavailable", "not_open"];

/** The alert for an error code of an action. The text is a platform message, never a provider text (U6). */
export function AuthErrorAlert({
  code,
  retryAfterSeconds,
  reference,
  extra,
}: {
  code: AuthErrorCode;
  retryAfterSeconds?: number;
  reference?: string;
  extra?: ReactNode;
}) {
  const t = useTranslations("Auth.error");
  const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60));
  return (
    <AuthAlert
      kind={WARNING_CODES.includes(code) ? "warning" : "danger"}
      {...(reference !== undefined ? { reference } : {})}
      {...(extra !== undefined ? { extra } : {})}
    >
      {t(code, { minutes })}
    </AuthAlert>
  );
}
