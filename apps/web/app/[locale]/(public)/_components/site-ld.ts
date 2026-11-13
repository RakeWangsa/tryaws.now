import { useTranslations } from "next-intl";
import type { Locale } from "@tc/ui/runtime";
import { siteLd } from "../../../../server/public/seo.ts";

/**
 * WPU-Z16: the Organization, WebSite and WebPage blocks of a public page. The organisation's
 * description is the entity statement (`Public.entity.statement`) and its legal name the company of
 * the footer, so the JSON-LD says what the home answer block, llms.txt and facts.json say.
 */
export function useSiteLd(locale: Locale) {
  const t = useTranslations("Public");
  const shell = useTranslations("Shell");
  const organization = {
    description: t("entity.statement"),
    legalName: shell("footer.companyName"),
  };
  return (
    origin: string,
    page: { path: string; name: string; description: string; answer: boolean },
  ) => siteLd({ origin, locale, organization, ...page });
}
