import { useTranslations } from "next-intl";
import type { ReactElement } from "react";

/**
 * The two logo images of the mockup (header.html). The theme's CSS shows one of them by
 * `data-background`, so both are in the markup.
 */
export function Logo({ className }: { className?: string }): ReactElement {
  const t = useTranslations("Shell");
  const extra = className === undefined ? "" : ` ${className}`;
  return (
    <>
      <img
        className={`svg logo-menu d-block${extra}`}
        src="/brand/logo.svg"
        alt={t("logoAlt")}
        width={200}
        height={50}
      />
      <img
        className={`svg logo-menu d-none${extra}`}
        src="/brand/logo-light.svg"
        alt={t("logoAlt")}
        width={200}
        height={50}
      />
    </>
  );
}
