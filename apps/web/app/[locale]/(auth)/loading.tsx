import { getLocale } from "next-intl/server";
import { AuthLoadingCard } from "./_components/AuthLoadingCard.tsx";
import { AuthPageFrame } from "./_components/AuthPageFrame.tsx";

/** The loading state of the sign-in screens: the frame and the card with placeholders (U11). */
export default async function AuthLoading() {
  const requested = await getLocale();
  const locale = requested === "en" ? "en" : "bn";
  return (
    <AuthPageFrame locale={locale} path="/">
      <AuthLoadingCard />
    </AuthPageFrame>
  );
}
