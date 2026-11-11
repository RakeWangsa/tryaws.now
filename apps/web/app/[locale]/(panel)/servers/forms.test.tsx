import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import type { FormState } from "../../../../server/action-state.ts";
import { configurator, noopAction, review } from "./servers.fixtures.ts";

// The forms keep the answer of their Server Action with useActionState. Static markup cannot submit,
// so the answer is injected here, and the test reads what each answer makes the form show.
const hold = vi.hoisted(() => ({ state: {} as unknown }));
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return { ...actual, useActionState: () => [hold.state, () => {}, false] };
});

const { PlaceForm } = await import("../orders/review/PlaceForm.tsx");
const { ConfigForm } = await import("./new/ConfigForm.tsx");
const { AddKeyForm } = await import("../settings/ssh-keys/KeyForms.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const readyReview = review({ balanceMinor: 150000n }) as Extract<
  ReturnType<typeof review>,
  { state: "ready" }
>;
const place = (locale: Locale, over = readyReview) =>
  intl(
    <PlaceForm
      locale={locale}
      review={over}
      idempotencyKey="0190aaaa-0000-7000-8000-0000000000e1"
      configureHref="/servers/new"
      action={noopAction}
    />,
    locale,
  );

beforeEach(() => {
  hold.state = {};
});

describe("PlaceForm (placeOrder)", () => {
  it("posts the token of the draft and the key of the view", () => {
    const html = place("en");
    expect(html).toContain('name="token" value="payload.mac"');
    expect(html).toContain('name="idempotencyKey" value="0190aaaa-0000-7000-8000-0000000000e1"');
  });

  it("on price_changed posts the NEW token and shows the old and the new total, without the old lines", () => {
    hold.state = {
      error: "price_changed",
      draft: { token: "fresh.token", totalMinor: "75000", expiresAt: "2026-11-12T01:30:00.000Z" },
    } satisfies FormState;
    const bn = place("bn");
    expect(bn).toContain('name="token" value="fresh.token"');
    expect(bn).not.toContain('value="payload.mac"');
    expect(bn).toContain("দাম বদলেছে");
    expect(bn).toContain("৳৬৯০.০০");
    expect(bn).toContain("৳৭৫০.০০");
    expect(bn).not.toContain("মূল্যের বিবরণ");
    const en = place("en");
    expect(en).toContain("The price changed");
    expect(en).toContain("Earlier price");
  });

  it("a new total above the balance turns the form into the shortfall state with a top-up link", () => {
    hold.state = {
      error: "price_changed",
      draft: { token: "fresh.token", totalMinor: "160000", expiresAt: "2026-11-12T01:30:00.000Z" },
    } satisfies FormState;
    const en = place("en");
    expect(en).toContain("Shortfall");
    expect(en).toContain("/en/wallet/topup?amount=100&amp;next=");
    expect(en).toContain("disabled");
  });

  it.each([
    ["kyc_required", "You need to finish identity verification"],
    ["insufficient_balance", "Your wallet balance is not enough"],
    ["forbidden", "not allowed to do this"],
    ["draft_expired", "The price has expired"],
    ["capacity_full", "This location is full"],
    ["unavailable", "You were not charged"],
  ])("shows %s in platform words, never raw text", (code, words) => {
    hold.state = { error: code } satisfies FormState;
    const html = place("en");
    expect(html).toContain(words);
    expect(html).toContain('role="alert"');
  });

  it("an unknown error key becomes the generic text", () => {
    hold.state = { error: "ThrottlingException: arn:aws:lightsail:..." } satisfies FormState;
    const html = place("en");
    expect(html).toContain("You were not charged");
    expect(html).not.toContain("ThrottlingException");
  });
});

describe("ConfigForm (createOrderDraft)", () => {
  const screen = configurator() as Extract<ReturnType<typeof configurator>, { state: "ready" }>;
  const config = (locale: Locale) =>
    intl(
      <ConfigForm
        locale={locale}
        plans={screen.plans}
        regions={screen.regions}
        keys={screen.keys}
        action={noopAction}
      />,
      locale,
    );

  it("shows only the plans of the first Region, with prices from the server, and a hidden plan id", () => {
    const html = config("en");
    expect(html).toContain('name="productId"');
    expect(html).toContain("৳690.00");
    // The plan of the other Region (৳720.00) is not offered until that Region is chosen.
    expect(html).not.toContain("৳720.00");
  });

  it("shows field errors from the server for the fields that were refused (U8)", () => {
    hold.state = {
      error: "validation",
      fields: { displayName: "invalid" },
    } satisfies FormState;
    const html = config("bn");
    expect(html).toContain("এই ঘরের তথ্য ঠিক নয়");
    expect(html).toContain("দেওয়া তথ্যে ভুল আছে");
  });
});

describe("AddKeyForm", () => {
  const add = (locale: Locale) => intl(<AddKeyForm action={noopAction} />, locale);

  it("shows the fields, and a refused key without echoing anything", () => {
    hold.state = { error: "validation", fields: { publicKey: "invalid" } } satisfies FormState;
    const html = add("en");
    expect(html).toContain('name="publicKey"');
    expect(html).toContain("The value in this field is not valid.");
    expect(html).not.toContain("PRIVATE KEY");
  });

  it("confirms an added key and a replay", () => {
    hold.state = { done: "added" } satisfies FormState;
    expect(add("en")).toContain("The key was added.");
    hold.state = { done: "replayed" } satisfies FormState;
    expect(add("bn")).toContain("এই কী আগেই যোগ করা ছিল");
  });
});
