import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../i18n/messages.ts";
import type { KycScreen } from "../../../../server/kyc-view.ts";
import { KycContent } from "./KycContent.tsx";
import { LIMITS, submission } from "./kyc.fixtures.ts";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id.

type Renderer = (locale: Locale) => string;

const never = async (): Promise<never> => {
  throw new Error("an action ran during a render");
};

export const kyc =
  (screen: KycScreen): Renderer =>
  (locale) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
        <KycContent
          numerals={locale === "bn" ? "beng" : "latn"}
          screen={screen}
          limits={LIMITS}
          startAction={never}
          submitAction={never}
          serversHref="/servers"
        />
      </NextIntlClientProvider>,
    );

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "kyc.form": kyc({ state: "form", customerType: null }),
  "kyc.pending": kyc({ state: "pending", submission: submission("pending") }),
  "kyc.verified": kyc({ state: "verified" }),
  "kyc.rejected": kyc({
    state: "rejected",
    submission: submission("rejected", "ছবি অস্পষ্ট"),
    customerType: "individual",
    canResubmit: true,
  }),
  "kyc.unavailable": kyc({ state: "unavailable" }),
};
