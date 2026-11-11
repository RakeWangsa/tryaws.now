import { useTranslations } from "next-intl";
import { SubmitButton } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { signOutAction } from "./sign-out-action.ts";

/**
 * The last entry of the account menu: a form that posts to the sign-out Server Action (a POST, so a
 * link in an email or an image cannot sign anybody out). The button is inert while it runs (U8).
 */
export function SignOutForm({ locale }: { locale: Locale }) {
  const t = useTranslations("Auth.signOut");
  return (
    <form action={signOutAction}>
      <input type="hidden" name="locale" value={locale} />
      <SubmitButton variant="tertiary" size="sm" icon="fas fa-right-from-bracket">
        {t("label")}
      </SubmitButton>
    </form>
  );
}
