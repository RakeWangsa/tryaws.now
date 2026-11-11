import { useTranslations } from "next-intl";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { LEGAL_PATHS } from "../../../../server/auth/legal.ts";

const BOXES = [
  { name: "consentTerms", id: "consent-terms", key: "terms", path: LEGAL_PATHS.terms },
  { name: "consentAup", id: "consent-aup", key: "aup", path: LEGAL_PATHS.acceptable_use },
  { name: "consentPrivacy", id: "consent-privacy", key: "privacy", path: LEGAL_PATHS.privacy },
] as const;

/**
 * The three consents of 16.9 as the "Remember Me" box of login.html (`ul.list > li > input +
 * label.checkbox-label`). Each links to its document (pages of another task, open point 29) in the
 * same tab. A box is never pre-ticked and is not echoed back after an error.
 */
export function ConsentBoxes({
  locale,
  error,
}: {
  locale: Locale;
  error: (name: string) => string | undefined;
}) {
  const t = useTranslations("Auth.consent");
  const word = useTranslations("kit.field");
  return (
    <ul className="list mb-4">
      {BOXES.map((box) => {
        const message = error(box.name);
        return (
          <li key={box.name} className="mb-2">
            <input
              name={box.name}
              type="checkbox"
              id={box.id}
              required
              aria-invalid={message !== undefined ? true : undefined}
              aria-describedby={message !== undefined ? `${box.id}-error` : undefined}
            />
            <label className="checkbox-label c-grey seccolor" htmlFor={box.id}>
              {t(box.key)}
            </label>{" "}
            <a className="golink" href={localePath(locale, box.path)}>
              {t("read")}
            </a>
            {message !== undefined ? (
              <p id={`${box.id}-error`} className="tc-field-error" role="alert">
                <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
                <span className="visually-hidden">{word("error")}</span>
                {message}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
