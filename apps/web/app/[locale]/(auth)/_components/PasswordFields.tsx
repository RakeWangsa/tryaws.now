import { useTranslations } from "next-intl";
import { Field } from "@tc/ui";

/**
 * Two password fields side by side (login.html, "Account security"): the password and its repeat.
 * Never prefilled. `new-password` lets a password manager offer a strong one.
 */
export function PasswordFields({
  error,
  labelKey = "password",
  hint = true,
}: {
  error: (name: string) => string | undefined;
  labelKey?: "password" | "newPassword";
  hint?: boolean;
}) {
  const t = useTranslations("Auth");
  const first = error("password");
  const second = error("passwordConfirm");
  return (
    <div className="row mb-5">
      <div className="col-md-6 position-relative">
        <Field
          name="password"
          type="password"
          label={t(`field.${labelKey}`)}
          icon="fas fa-lock"
          autoComplete="new-password"
          maxLength={512}
          required
          spellCheck={false}
          autoCapitalize="off"
          {...(hint ? { hint: t("hint.password") } : {})}
          {...(first !== undefined ? { error: first } : {})}
        />
      </div>
      <div className="col-md-6 position-relative">
        <Field
          name="passwordConfirm"
          type="password"
          label={t("field.passwordConfirm")}
          icon="fas fa-lock"
          autoComplete="new-password"
          maxLength={512}
          required
          spellCheck={false}
          autoCapitalize="off"
          {...(second !== undefined ? { error: second } : {})}
        />
      </div>
    </div>
  );
}
