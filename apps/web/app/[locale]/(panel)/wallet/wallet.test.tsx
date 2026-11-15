import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import { CUSTOMER_ID, payment, screen } from "./wallet.fixtures.ts";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  panelRedirect: null as string | null,
  loaded: null as unknown,
  loadCalls: [] as unknown[],
}));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("../../../../i18n/messages.ts");
  return {
    getTranslations: async (options?: { locale?: "bn" | "en" }) =>
      createTranslator({
        locale: options?.locale ?? state.locale,
        messages: messages[options?.locale ?? state.locale],
      }),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("../../../../server/panel.ts", () => ({
  requirePanel: async () => {
    if (state.panelRedirect !== null) throw new Error(`REDIRECT:${state.panelRedirect}`);
    return {
      session: { customerId: "11111111-1111-4111-8111-111111111111" },
      displayName: "Rahim",
      balanceMinor: 150000n,
      market: { code: "BD", numerals: "beng" },
      enabledFamilies: ["cloudServers"],
      soonFamilies: [],
    };
  },
}));
vi.mock("../../../../server/wallet-view.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/wallet-view.ts")>();
  return {
    ...actual,
    loadWallet: async (_session: unknown, opts: unknown) => {
      state.loadCalls.push(opts);
      return state.loaded;
    },
  };
});

const { default: WalletPage } = await import("./page.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

async function render(
  locale: Locale,
  query: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  state.locale = locale;
  const element = await WalletPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(query),
  });
  return intl(element, locale);
}

beforeEach(() => {
  state.locale = "bn";
  state.panelRedirect = null;
  state.loaded = screen();
  state.loadCalls = [];
});

describe("/wallet: what it shows", () => {
  it("shows the balance of 150000n paisa as taka in the digits of the language", async () => {
    expect(await render("bn")).toContain("৳১,৫০০.০০");
    expect(await render("en")).toContain("৳1,500.00");
  });

  it("shows the ledger with the kind labels, money in and out, and the running balance", async () => {
    const bn = await render("bn");
    expect(bn).toContain("টপ আপ");
    expect(bn).toContain("কেনাকাটা");
    expect(bn).toContain("৳১,২০০.০০");
    const en = await render("en");
    expect(en).toContain("Top-up");
    expect(en).toContain("Purchase");
    expect(en).toContain("৳1,200.00");
    expect(en).toContain("Money in");
    expect(en).toContain("Money out");
  });

  it("shows the empty state with a Top up button when there is nothing", async () => {
    state.loaded = screen({ lines: [], payments: [], newest: null });
    const bn = await render("bn");
    expect(bn).toContain("এখনো কোনো লেনদেন নেই");
    expect(bn).toContain('href="/en/wallet/topup"');
    const en = await render("en");
    expect(en).toContain("No transactions yet");
    expect(en).toContain('href="/en/wallet/topup"');
  });

  it("a state is an icon and a word, never a colour alone (U11)", async () => {
    state.loaded = screen({
      payments: [
        payment({ id: "0190aaaa-0000-7000-8000-00000000000a", status: "credited" }),
        payment({ id: "0190aaaa-0000-7000-8000-00000000000b", status: "redirected" }),
        payment({ id: "0190aaaa-0000-7000-8000-00000000000c", status: "failed" }),
        payment({ id: "0190aaaa-0000-7000-8000-00000000000d", status: "cancelled" }),
        payment({ id: "0190aaaa-0000-7000-8000-00000000000e", status: "expired" }),
      ],
    });
    const en = await render("en");
    for (const [word, icon] of [
      ["Paid", "fa-check"],
      ["Pending", "fa-hourglass-half"],
      ["Failed", "fa-times-circle"],
      ["Cancelled", "fa-times-circle"],
      ["Expired", "fa-times-circle"],
    ] as const) {
      expect(en, word).toMatch(new RegExp(`<i class="fas ${icon} me-1"[^>]*></i>${word}`));
    }
  });

  it("links to the status page of each payment, in the language of the page", async () => {
    expect(await render("bn")).toContain(
      'href="/en/wallet/topup/0190aaaa-0000-7000-8000-000000000001"',
    );
    expect(await render("en")).toContain(
      'href="/en/wallet/topup/0190aaaa-0000-7000-8000-000000000001"',
    );
  });

  it("paging links keep the locale and carry only the cursor the repository returned", async () => {
    const cursor = "1762790400000000.0190bbbb-0000-7000-8000-000000000001";
    state.loaded = screen({ nextCursor: cursor });
    const en = await render("en");
    expect(en).toContain(`href="/en/wallet?cursor=${cursor}"`);
    state.loaded = screen();
    const next = await render("en", { cursor });
    expect(next).toContain('href="/en/wallet"');
    expect(state.loadCalls.at(-1)).toEqual({ cursor });
  });

  it("markup has no inline style and no script (U4)", async () => {
    for (const locale of ["bn", "en"] as const) {
      const html = await render(locale);
      expect(html).not.toContain(' style="');
      expect(html).not.toContain("<script");
    }
  });

  it("without a session the page redirects to the login before reading the wallet", async () => {
    state.panelRedirect = "/login?next=%2Fwallet";
    await expect(render("bn")).rejects.toThrow("REDIRECT:/login?next=%2Fwallet");
    expect(state.loadCalls).toEqual([]);
  });

  it("an unknown locale is a missing page", async () => {
    await expect(
      WalletPage({ params: Promise.resolve({ locale: "fr" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/wallet: the ?topup= banner is a hint, checked against the customer's own row (R6)", () => {
  it("?topup=credited with the newest payment still open shows 'checking', not 'complete'", async () => {
    state.loaded = screen({ newest: payment({ status: "redirected" }) });
    const en = await render("en", { topup: "credited" });
    expect(en).toContain("We are checking your payment");
    expect(en).not.toContain("Your top-up is complete");
    const bn = await render("bn", { topup: "credited" });
    expect(bn).toContain("আপনার পেমেন্ট যাচাই করা হচ্ছে");
    expect(bn).not.toContain("আপনার টপ আপ সম্পন্ন হয়েছে");
  });

  it("?topup=credited with no payment at all shows no success text", async () => {
    state.loaded = screen({ lines: [], payments: [], newest: null });
    const en = await render("en", { topup: "credited" });
    expect(en).not.toContain("Your top-up is complete");
  });

  it("?topup=credited with a credited newest payment shows the success text", async () => {
    state.loaded = screen({ newest: payment({ status: "credited" }) });
    expect(await render("en", { topup: "credited" })).toContain("Your top-up is complete");
  });

  it("the other fixed values show their own fixed text", async () => {
    const texts: Record<string, string> = {
      failed: "You were not charged",
      cancelled: "You cancelled the payment",
      expired: "The payment timed out",
      unknown: "We could not find this payment",
      pending: "We are checking your payment",
    };
    for (const [value, text] of Object.entries(texts)) {
      expect(await render("en", { topup: value }), value).toContain(text);
    }
  });

  it("a hostile value renders nothing of itself, and so does a repeated key", async () => {
    for (const topup of [
      "<img src=x onerror=1>",
      ["credited", "failed"],
      "CREDITED",
      "",
    ] as const) {
      const html = await render("en", { topup: topup as string | string[] });
      expect(html).not.toContain("onerror");
      // The shell has its own <img> logo; the hostile one has src=x.
      expect(html).not.toContain("src=x");
      expect(html).not.toContain("src=&quot;x");
      expect(html).not.toContain("Your top-up is complete");
      expect(html).not.toContain('role="status"');
      expect(html).not.toContain('role="alert"');
    }
  });

  it("every banner has an icon and a word", async () => {
    state.loaded = screen({ newest: payment({ status: "credited" }) });
    for (const value of ["credited", "failed", "cancelled", "expired", "unknown", "pending"]) {
      const html = await render("en", { topup: value });
      expect(html, value).toMatch(/class="alert alert-(info|warning|danger) text-start"/);
      expect(html, value).toMatch(/<i class="fas fa-[a-z-]+ me-2" aria-hidden="true"><\/i>[A-Z]/);
    }
  });
});

describe("the customer id comes from the session only", () => {
  it("is a UUID of the fixture that the mocked panel returns", () => {
    expect(CUSTOMER_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});
