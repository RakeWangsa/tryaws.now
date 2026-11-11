import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES } from "@tc/ui/runtime";

// 16.7: `bn` at the root, `en` under `/en`; the Accept-Language header never redirects, no cookie.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});
