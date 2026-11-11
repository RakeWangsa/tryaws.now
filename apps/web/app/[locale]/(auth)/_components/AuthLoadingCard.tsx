import { useTranslations } from "next-intl";
import { Skeleton } from "@tc/ui";
import { AuthCard } from "./AuthCard.tsx";

/** The final card with placeholders in the places of the form (U11). */
export function AuthLoadingCard() {
  const t = useTranslations("Auth");
  return (
    <AuthCard title={t("card.title")}>
      <div aria-busy="true">
        <Skeleton lines={6} />
      </div>
    </AuthCard>
  );
}
