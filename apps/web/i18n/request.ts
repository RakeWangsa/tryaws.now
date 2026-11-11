import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE } from "@tc/ui/runtime";
import { webMessages } from "./messages.ts";
import { routing } from "./routing.ts";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : DEFAULT_LOCALE;
  return { locale, messages: webMessages[locale], timeZone: "Asia/Dhaka" };
});
