import { loadKitMessages } from "@tc/ui/messages";
import type { AbstractIntlMessages } from "next-intl";
import type { Locale, Messages } from "@tc/ui/runtime";
import { adminMessages } from "../../../i18n/messages.ts";

// The root layout hands the browser only the kit messages. LoginForm is the one client component of
// this app that translates its own text, so the page gives it the kit messages plus Admin.login and
// nothing else (staging 2026-11-14: without this the form showed the raw keys, "Admin.login.code").
export function loginClientMessages(locale: Locale): AbstractIntlMessages {
  const admin = (adminMessages[locale] as { Admin: { login: Messages } }).Admin;
  // The kit messages are typed with unknown leaves (packages/ui/messages); they are strings at run time.
  const kit = loadKitMessages(locale) as unknown as AbstractIntlMessages;
  return { ...kit, Admin: { login: admin.login } };
}
