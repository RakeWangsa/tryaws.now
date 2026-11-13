import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../../i18n/messages.ts";
import type { CustomerSupportRequestRow } from "../../../../../server/support-view.ts";
import { SupportContent } from "./SupportContent.tsx";
import { SupportDone, SupportForm } from "./SupportForm.tsx";

// The renderers behind the rows of mockup-anchors.ts: one function for each state id.

type Renderer = (locale: Locale) => string;

const never = async (): Promise<never> => {
  throw new Error("an action ran during a render");
};

const REQUESTS: readonly CustomerSupportRequestRow[] = [
  {
    id: "0190aaaa-0000-7000-8000-000000000001",
    category: "billing",
    subject: "Top-up not shown",
    status: "open",
    createdAt: new Date("2026-11-10T04:00:00Z"),
    lastActivityAt: new Date("2026-11-10T04:00:00Z"),
  },
  {
    id: "0190aaaa-0000-7000-8000-000000000002",
    category: "technical",
    subject: "সার্ভার ধীর",
    status: "closed",
    createdAt: new Date("2026-11-01T04:00:00Z"),
    lastActivityAt: new Date("2026-11-02T04:00:00Z"),
  },
];

const render =
  (node: ReactNode): Renderer =>
  (locale) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
        {node}
      </NextIntlClientProvider>,
    );

const content =
  (requests: readonly CustomerSupportRequestRow[]): Renderer =>
  (locale) =>
    render(
      <SupportContent
        locale={locale}
        numerals={locale === "bn" ? "beng" : "latn"}
        requests={requests}
        action={never}
      />,
    )(locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "support.form": content([]),
  "support.empty": content([]),
  "support.list": content(REQUESTS),
  "support.done": render(
    <SupportDone id="0190aaaa-0000-7000-8000-000000000001" replayed={false} onAgain={() => {}} />,
  ),
  "support.error": render(<SupportForm action={never} initialError="rate_limited" />),
};
