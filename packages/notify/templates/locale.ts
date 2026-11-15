import type { Locale } from "@tc/core";

// WPU-X22 (owner, 2026-11-15): every message a customer receives (e-mail, SMS, bell item, Cognito
// codes and reset mails) is English, whatever the stored `customers.locale` says. Nothing is deleted:
// the bn texts (messages.ts, cognito.ts, layout.ts) and the stored preference stay, so Bengali comes
// back by setting `englishOnly` to false (see JOURNEY.md, WPU-X22). The choice is made here, once, at
// the render doors, so what is sent and when does not change, only the language.
let englishOnly = true;

export function notifyLocale(stored: Locale): Locale {
  return englishOnly ? "en" : stored;
}

// Test seam: the tests of the bn texts switch the rule off so that the kept Bengali templates stay
// covered; the English-only test switches it on. Production never calls it.
export function setNotifyEnglishOnly(value: boolean): void {
  englishOnly = value;
}
