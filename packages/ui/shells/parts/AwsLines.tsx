import { useTranslations } from "next-intl";
import type { ReactElement } from "react";

/** The AWS statement of 16.13 and the trademark line, from messages and unchanged (rule U6). */
export function AwsLines({ variant }: { variant: "short" | "long" }): ReactElement {
  const t = useTranslations("Aws");
  return (
    <>
      <p className="seccolor">{variant === "long" ? t("long") : t("short")}</p>
      <p className="small seccolor">{t("trademark")}</p>
    </>
  );
}
