"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { reauthHref } from "../../../../server/next-path.ts";

/**
 * WPU-X20: after the answer "fresh_sign_in_required" (the sign-in is older than 10 minutes, 6.1) the notice
 * offers a working way: the sign-in page, opened for a signed-in customer (`reauth=1`), that comes back to this
 * page. It renders nothing for any other error.
 */
export function FreshSignInLink({ error }: { error: string | undefined }) {
  const t = useTranslations("Flow");
  const locale = useLocale();
  const pathname = usePathname();
  if (error !== "fresh_sign_in_required") return null;
  return (
    <>
      {" "}
      <a href={reauthHref(locale, pathname ?? "")}>{t("reauthLink")}</a>
    </>
  );
}
