import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import type { FormState } from "../../../../server/action-state.ts";
import {
  PRODUCT_A,
  PRODUCT_B,
  configurator,
  noopAction,
  plan,
  review,
} from "./servers.fixtures.ts";

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
// A dollar sign followed by a digit, Latin or Bengali: how formatUsd prints a USD amount ("$5.75", "$৫.৭৫").
const USD_AMOUNT = /\$\s*[\d০-৯]/;
const AUTO_RENEW_EN =
  "Auto-renew is on: the next period is paid from your wallet when this one ends. You can turn it off at any time on the Billing tab.";
const AUTO_RENEW_BN =
  "স্বয়ংক্রিয় নবায়ন চালু আছে: এই মেয়াদ শেষ হলে পরবর্তী মেয়াদ আপনার ওয়ালেট থেকে পরিশোধ হবে। বিলিং ট্যাবে যেকোনো সময় এটি বন্ধ করতে পারবেন।";
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

  // WPU-Z2 (owner decision of 2026-11-13): the panel shows BDT only. The draft still carries a USD text
  // ("5.75"); the review does not print it. Today's rate and the day it was set stay (the owner's
  // transparency rule).
  it("WPU-Z2: shows today's rate with the day it was set and the BDT debited, and no USD amount", () => {
    const en = place("en");
    expect(en).not.toContain("Price in US dollars");
    expect(en).not.toMatch(USD_AMOUNT);
    expect(en).toContain("1 USD = ৳120, set on");
    expect(en).toContain("Nov 10, 2026");
    expect(en).toContain("Amount debited from your wallet (taka)");
    expect(en).toContain("৳690.00");
    expect(en).toContain("exactly what is taken from your wallet");
    const bn = place("bn");
    expect(bn).not.toContain("মার্কিন ডলারে মূল্য");
    expect(bn).not.toMatch(USD_AMOUNT);
    expect(bn).toContain("১ USD = ৳১২০");
    expect(bn).toContain("৳৬৯০.০০");
    // a draft signed before the rate was carried has no date, and says no date
    expect(place("en", { ...readyReview, fxSetAt: null })).toContain("1 USD = ৳120<");
  });

  it("WPU-Z2: before the customer confirms, says auto-renew is on, after the total and before the terms, in bn and en", () => {
    const en = place("en");
    expect(en).toContain(AUTO_RENEW_EN);
    expect(en.indexOf(AUTO_RENEW_EN)).toBeGreaterThan(en.indexOf("Price details"));
    expect(en.indexOf(AUTO_RENEW_EN)).toBeLessThan(en.indexOf("I have read and accept the terms"));
    const bn = place("bn");
    expect(bn).toContain(AUTO_RENEW_BN);
    expect(bn.indexOf(AUTO_RENEW_BN)).toBeGreaterThan(bn.indexOf("মূল্যের বিবরণ"));
    expect(bn.indexOf(AUTO_RENEW_BN)).toBeLessThan(bn.indexOf("আমি শর্তাবলি"));
    // A changed price is confirmed again: the line is there too.
    hold.state = {
      error: "price_changed",
      draft: {
        token: "fresh.token",
        totalMinor: "75000",
        expiresAt: "2026-11-12T01:30:00.000Z",
        usdText: "5.00",
        fxRate: "150",
        fxSetAt: "2026-11-12T04:00:00.000Z",
      },
    } satisfies FormState;
    expect(place("en")).toContain(AUTO_RENEW_EN);
    expect(place("bn")).toContain(AUTO_RENEW_BN);
  });

  it("WPU-Y4, WPU-Z2: after a rate change the new rate and the new BDT replace the old and ask to confirm again, without a USD amount", () => {
    hold.state = {
      error: "price_changed",
      draft: {
        token: "fresh.token",
        totalMinor: "75000",
        expiresAt: "2026-11-12T01:30:00.000Z",
        usdText: "5.00",
        fxRate: "150",
        fxSetAt: "2026-11-12T04:00:00.000Z",
      },
    } satisfies FormState;
    const en = place("en");
    expect(en).toContain("1 USD = ৳150, set on");
    expect(en).toContain("Nov 12, 2026");
    expect(en).not.toMatch(USD_AMOUNT);
    expect(place("bn")).not.toMatch(USD_AMOUNT);
    expect(en).not.toContain("1 USD = ৳120");
    expect(en).toContain("The price changed");
    expect(en).toContain("৳750.00");
    expect(en).toContain('name="token" value="fresh.token"');
  });

  it("on price_changed posts the NEW token and shows the old and the new total, without the old lines", () => {
    hold.state = {
      error: "price_changed",
      draft: {
        token: "fresh.token",
        totalMinor: "75000",
        expiresAt: "2026-11-12T01:30:00.000Z",
        usdText: "5.00",
        fxRate: "150",
        fxSetAt: "2026-11-12T04:00:00.000Z",
      },
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
      draft: {
        token: "fresh.token",
        totalMinor: "160000",
        expiresAt: "2026-11-12T01:30:00.000Z",
        usdText: "10.00",
        fxRate: "160",
        fxSetAt: null,
      },
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
    ["prices_updating", "Prices are being updated"],
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
        images={screen.images}
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

  it("WPU-G3: shows the images of the first Region in two groups, with the logo or the generic icon and the login user", () => {
    const en = config("en");
    expect(en).toContain("Apps + OS");
    expect(en).toContain("OS only");
    expect(en.indexOf("Apps + OS")).toBeLessThan(en.indexOf("OS only"));
    expect(en).toContain('name="blueprintId" value="wordpress"');
    // The first OS is preselected: the customer cannot submit without an image.
    expect(en).toContain('name="blueprintId" checked="" value="ubuntu_24_04"');
    expect(en).not.toContain('name="blueprintId" checked="" value="wordpress"');
    expect(en).toContain("/theme/assets/apps/ubuntu.svg");
    expect(en).toContain("tc-image-tile-generic");
    expect(en).toContain("Login user: ubuntu");
    expect(en).toContain("Ubuntu 24.04 LTS");
    const bn = config("bn");
    expect(bn).toContain("অ্যাপ ও OS");
    expect(bn).toContain("শুধু OS");
    expect(bn).toContain("লগইন ইউজার: ubuntu");
  });

  it("the image step comes after the location and before the plan, and the summary names the image", () => {
    const en = config("en");
    expect(en.indexOf("Location")).toBeLessThan(en.indexOf(">Image<"));
    expect(en.indexOf(">Image<")).toBeLessThan(en.indexOf("Choose a plan"));
    expect(en).toContain("Image</div></td><td>Ubuntu</td>");
  });

  it("WPU-G6: the key is required, with no empty choice, the first key is preselected, and the page links to the key page", () => {
    const en = config("en");
    expect(en).toMatch(/<select[^>]*name="keyPairId"[^>]*required/);
    expect(en).not.toContain('<option value=""');
    expect(en).not.toContain("No key");
    expect(en).toContain("An SSH key is needed");
    expect(en).toContain('href="/en/settings/ssh-keys"');
    expect(en).not.toContain("disabled");
  });

  it("WPU-G10: the key step offers the three ways of the console, and the existing key is the first when there is one", () => {
    const en = config("en");
    expect(en).toContain('name="keyMode" value="existing"');
    expect(en).toContain("Use a key I already have");
    expect(en).toContain("Create a new key pair");
    expect(en).toContain("Upload my public key");
    // the other two modes post their fields only when chosen
    expect(en).not.toContain('name="newKeyName"');
    expect(en).not.toContain('name="newKeyPublic"');
    const bn = config("bn");
    expect(bn).toContain("নতুন কী জোড়া বানাব");
    expect(bn).toContain("আমার পাবলিক কী দেব");
  });

  it("WPU-G10: a customer with no key starts on the new key pair; the server cannot be created before the private key is downloaded", () => {
    const noKeys = intl(
      <ConfigForm
        locale="en"
        plans={screen.plans}
        regions={screen.regions}
        keys={[]}
        images={screen.images}
        action={noopAction}
      />,
      "en",
    );
    expect(noKeys).not.toContain("Add an SSH key first");
    expect(noKeys).not.toContain('name="keyPairId"');
    expect(noKeys).toContain('name="keyMode" value="generate"');
    expect(noKeys).not.toContain("Use a key I already have");
    expect(noKeys).toContain('name="newKeyName"');
    expect(noKeys).toContain('<input type="hidden" name="newKeyPublic" value=""');
    expect(noKeys).toContain("The private key never reaches us");
    expect(noKeys).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    // no private key text and no download link before a pair exists
    expect(noKeys).not.toContain("PRIVATE KEY");
    expect(noKeys).not.toContain("Download private key");
  });

  it("WPU-G10: a plan below the minimum power of the image is disabled with the reason, and the choice moves to a plan that fits", () => {
    const small = plan({ id: PRODUCT_A, specs: { vcpus: 1, ramGb: "0.5" }, power: 500 });
    const big = plan({ id: PRODUCT_B, specs: { vcpus: 2, ramGb: "1" }, power: 1000 });
    const withApp = (minPower: number) =>
      intl(
        <ConfigForm
          locale="en"
          plans={[small, big]}
          regions={["ap-south-1"]}
          keys={screen.keys}
          images={{
            "ap-south-1": [
              {
                id: "wordpress",
                name: "WordPress",
                kind: "app",
                version: null,
                loginUser: "bitnami",
                logo: "wordpress",
                minPower,
              },
            ],
          }}
          action={noopAction}
        />,
        "en",
      );
    const en = withApp(1000);
    const radio = (id: string) =>
      (en.match(/<input[^>]*tc-plan-radio[^>]*>/g) ?? []).find((tag) => tag.includes(id)) ?? "";
    expect(radio(PRODUCT_A)).toContain("disabled");
    expect(radio(PRODUCT_B)).not.toContain("disabled");
    expect(radio(PRODUCT_B)).toContain("checked");
    expect(en).toContain("Too small for this image");
    expect(en).toContain("WordPress needs a plan with 1 GB RAM or more");
    // the hidden plan id is the plan that fits
    expect(en).toContain('name="productId" value="0190aaaa-0000-7000-8000-0000000000b2"');
    // a minimum of 0 disables nothing and shows no explanation
    const free = withApp(0);
    expect(free).not.toContain("Too small for this image");
    expect(free).not.toContain("needs a plan with");
  });

  it("WPU-G10: when no plan of the Region fits the image the form says so and cannot be submitted", () => {
    const html = intl(
      <ConfigForm
        locale="en"
        plans={[plan({ power: 500 })]}
        regions={["ap-south-1"]}
        keys={screen.keys}
        images={{
          "ap-south-1": [
            {
              id: "wordpress",
              name: "WordPress",
              kind: "app",
              version: null,
              loginUser: "bitnami",
              logo: "wordpress",
              minPower: 2000,
            },
          ],
        }}
        action={noopAction}
      />,
      "en",
    );
    expect(html).toContain("No plan in this location is big enough to run WordPress");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    const bn = intl(
      <ConfigForm
        locale="bn"
        plans={[plan({ power: 500 })]}
        regions={["ap-south-1"]}
        keys={screen.keys}
        images={{
          "ap-south-1": [
            {
              id: "wordpress",
              name: "WordPress",
              kind: "app",
              version: null,
              loginUser: "bitnami",
              logo: "wordpress",
              minPower: 2000,
            },
          ],
        }}
        action={noopAction}
      />,
      "bn",
    );
    expect(bn).toContain("চালানোর মতো বড় প্ল্যান এই লোকেশনে নেই");
  });

  it("WPU-G10: the answers of the server for the new key and for a plan too small are shown at their fields", () => {
    hold.state = {
      error: "validation",
      fields: { newKeyName: "taken", productId: "plan_too_small" },
    } satisfies FormState;
    const noKeys = intl(
      <ConfigForm
        locale="en"
        plans={screen.plans}
        regions={screen.regions}
        keys={[]}
        images={screen.images}
        action={noopAction}
      />,
      "en",
    );
    expect(noKeys).toContain("You already have another key with this name");
    expect(noKeys).toContain("This plan is too small for the image");
  });

  it("a Region with no image says so", () => {
    const noImages = intl(
      <ConfigForm
        locale="en"
        plans={screen.plans}
        regions={screen.regions}
        keys={screen.keys}
        images={{ "ap-south-1": [], "ap-southeast-1": [] }}
        action={noopAction}
      />,
      "en",
    );
    expect(noImages).toContain("No image is available in this location right now");
    expect(noImages).not.toContain('name="blueprintId"');
    expect(noImages).toMatch(/<button[^>]*disabled/);
  });

  it("a refused image or key shows the field error from the server (U8)", () => {
    hold.state = {
      error: "validation",
      fields: { blueprintId: "required", keyPairId: "required" },
    } satisfies FormState;
    const html = config("en");
    expect(html.match(/The value in this field is not valid\./g)?.length).toBeGreaterThanOrEqual(2);
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
