import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import type { ProfileScreen } from "../../../../server/settings-view.ts";
import { ProfileContent } from "./profile/ProfileContent.tsx";
import { SecurityContent } from "./security/SecurityContent.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id. No action
// runs during a render.

type Renderer = (locale: Locale) => string;

const never = async (): Promise<never> => {
  throw new Error("an action ran during a render");
};
const actions = {
  updateProfile: never,
  updateBilling: never,
  startEmail: never,
  confirmEmail: never,
  startPhone: never,
  confirmPhone: never,
};

export const SCREEN: ProfileScreen = {
  name: "করিম রহমান",
  email: "karim@example.test",
  phoneMasked: "+88017••••5678",
  phoneVerified: true,
  locale: "bn",
  open: true,
  billing: {
    billingName: "",
    billingAddress: "",
    customerBin: "",
  },
};

const inProvider = (locale: Locale, node: React.ReactElement): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );

export const profile =
  (screen: ProfileScreen): Renderer =>
  (locale) =>
    inProvider(
      locale,
      <ProfileContent
        screen={screen}
        actions={actions}
        signInHref="/login?next=/settings/profile"
        securityHref="/settings/security"
      />,
    );

export const security =
  (open: boolean, totpEnabled: boolean | null = false): Renderer =>
  (locale) =>
    inProvider(
      locale,
      <SecurityContent
        open={open}
        changePassword={never}
        signInHref="/login?next=/settings/security"
        profileHref="/settings/profile"
        totp={{ enabled: totpEnabled, start: never, confirm: never, disable: never }}
      />,
    );

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "settings.profile.open": profile(SCREEN),
  "settings.profile.closed": profile({ ...SCREEN, open: false }),
  "settings.profile.nophone": profile({
    ...SCREEN,
    phoneMasked: null,
    phoneVerified: false,
    name: "",
  }),
  "settings.security.open": security(true),
  "settings.security.closed": security(false),
  // WPU-X11: the authenticator switched on (the off state is "settings.security.open").
  "settings.security.totp_on": security(true, true),
};
