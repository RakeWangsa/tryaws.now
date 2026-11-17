import { useTranslations } from "next-intl";
import type { ReactElement } from "react";

/** The author's profile, named in the NOTICE file of the repository (Apache-2.0 section 4(d)). */
export const CREDIT_URL = "https://www.linkedin.com/in/in-moshiur";

/** The open-source credit line of every shell, from messages (U5). It sits next to the AWS statement. */
export function CreditLine(): ReactElement {
  const t = useTranslations("Shell");
  return (
    <p className="small seccolor">
      {t("credit.text")}{" "}
      <a href={CREDIT_URL} rel="noopener noreferrer author">
        {t("credit.link")}
      </a>
    </p>
  );
}
