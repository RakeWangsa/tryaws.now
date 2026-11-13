import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Locale } from "@tc/ui/runtime";
import { webMessages } from "../../../../../i18n/messages.ts";
import type {
  CustomerSupportRequestRow,
  CustomerSupportThread,
} from "../../../../../server/support-view.ts";
import { RequestsContent } from "./RequestsContent.tsx";
import { ThreadContent } from "./[id]/ThreadContent.tsx";
import { ReplyForm } from "./[id]/ThreadForms.tsx";

// The renderers behind the rows of mockup-anchors.ts and the render tests: one function for each state id.

type Renderer = (locale: Locale) => string;

const never = async (): Promise<never> => {
  throw new Error("an action ran during a render");
};

export const REQUEST_ID = "0191a000-0000-7000-8000-0000000000e1";
export const REPLY_KEY = "0191a000-0000-7000-8000-0000000000aa";

export const REQUESTS: readonly CustomerSupportRequestRow[] = [
  {
    id: REQUEST_ID,
    category: "billing",
    subject: "Top-up not shown",
    status: "answered",
    createdAt: new Date("2026-11-10T04:00:00Z"),
    lastActivityAt: new Date("2026-11-12T09:30:00Z"),
  },
  {
    id: "0191a000-0000-7000-8000-0000000000e2",
    category: "technical",
    subject: "সার্ভার ধীর",
    status: "open",
    createdAt: new Date("2026-11-11T04:00:00Z"),
    lastActivityAt: new Date("2026-11-11T04:00:00Z"),
  },
  {
    id: "0191a000-0000-7000-8000-0000000000e3",
    category: "other",
    subject: "<b>not bold</b>",
    status: "closed",
    createdAt: new Date("2026-11-01T04:00:00Z"),
    lastActivityAt: new Date("2026-11-02T04:00:00Z"),
  },
];

export const THREAD: CustomerSupportThread = {
  id: REQUEST_ID,
  category: "billing",
  subject: "Top-up not shown",
  status: "answered",
  createdAt: new Date("2026-11-10T04:00:00Z"),
  lastActivityAt: new Date("2026-11-12T09:30:00Z"),
  message: "My payment went through\nbut the wallet did not change.",
  messages: [
    {
      id: "0191a000-0000-7000-8000-0000000000f1",
      authorType: "admin",
      body: "We are checking it.",
      createdAt: new Date("2026-11-11T05:00:00Z"),
    },
    {
      id: "0191a000-0000-7000-8000-0000000000f2",
      authorType: "customer",
      body: "Thank you.",
      createdAt: new Date("2026-11-11T06:00:00Z"),
    },
    {
      id: "0191a000-0000-7000-8000-0000000000f3",
      authorType: "admin",
      body: "The top-up is credited now.",
      createdAt: new Date("2026-11-12T09:30:00Z"),
    },
  ],
  hasEarlier: false,
};

export const render =
  (node: ReactNode): Renderer =>
  (locale) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
        {node}
      </NextIntlClientProvider>,
    );

const list =
  (requests: readonly CustomerSupportRequestRow[]): Renderer =>
  (locale) =>
    render(
      <RequestsContent
        locale={locale}
        numerals={locale === "bn" ? "beng" : "latn"}
        requests={requests}
      />,
    )(locale);

export const thread =
  (value: CustomerSupportThread | null): Renderer =>
  (locale) =>
    render(
      <ThreadContent
        locale={locale}
        numerals={locale === "bn" ? "beng" : "latn"}
        thread={value}
        replyKey={REPLY_KEY}
        replyAction={never}
        closeAction={never}
      />,
    )(locale);

export const STATE_RENDERERS: Readonly<Record<string, Renderer>> = {
  "requests.list": list(REQUESTS),
  "requests.empty": list([]),
  "thread.ready": thread(THREAD),
  "thread.closed": thread({ ...THREAD, status: "closed" }),
  "thread.error": render(
    <ReplyForm
      requestId={REQUEST_ID}
      idempotencyKey={REPLY_KEY}
      closed={false}
      action={never}
      initialError="rate_limited"
    />,
  ),
  "thread.notFound": thread(null),
};
