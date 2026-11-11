import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../../i18n/messages.ts";
import { payment } from "../../wallet.fixtures.ts";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  panelRedirect: null as string | null,
  rows: new Map<string, { customerId: string; row: unknown; balance: bigint }>(),
  sessionCustomer: "11111111-1111-4111-8111-111111111111",
  loaded: [] as string[],
}));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("../../../../../../i18n/messages.ts");
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
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("../../../../../../server/panel.ts", () => ({
  requirePanel: async () => {
    if (state.panelRedirect !== null) throw new Error(`REDIRECT:${state.panelRedirect}`);
    return {
      session: { customerId: state.sessionCustomer },
      displayName: "Rahim",
      balanceMinor: 150000n,
      market: { code: "BD", numerals: "beng" },
      enabledFamilies: ["cloudServers"],
      soonFamilies: [],
    };
  },
}));
// The repository is bound to the session's customer: a row of someone else is null (R8).
vi.mock("../../../../../../server/topup-view.ts", () => ({
  loadPayment: async (session: { customerId: string }, id: string) => {
    state.loaded.push(id);
    const found = state.rows.get(id);
    if (found === undefined || found.customerId !== session.customerId) return null;
    return { payment: found.row, balanceMinor: found.balance };
  },
}));
vi.mock("./actions.ts", () => ({
  recheckPaymentAction: async () => ({ state: "pending", review: false }),
  checkAgainAction: async () => {},
}));

const { default: StatusPage } = await import("./page.tsx");

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "0190aaaa-0000-7000-8000-000000000001";
const SECRET_MTID = "MTID-SECRET-0001";

function seed(status: string, over: { customerId?: string; balance?: bigint } = {}, id = ID) {
  state.rows.set(id, {
    customerId: over.customerId ?? ME,
    row: payment({ id, status, merchantTransactionId: SECRET_MTID }),
    balance: over.balance ?? 150000n,
  });
}

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

async function render(locale: Locale, paymentId = ID): Promise<string> {
  state.locale = locale;
  const element = await StatusPage({ params: Promise.resolve({ locale, paymentId }) });
  return intl(element, locale);
}

beforeEach(() => {
  state.locale = "bn";
  state.panelRedirect = null;
  state.rows = new Map();
  state.sessionCustomer = ME;
  state.loaded = [];
});

describe("the status page: one test for each state", () => {
  it("credited: the title, the amount, the live balance of the customer, and the two buttons", async () => {
    seed("credited", { balance: 150000n });
    const en = await render("en");
    expect(en).toContain("Top-up complete");
    expect(en).toContain("৳1,500.00 was added. Your new balance is ৳1,500.00.");
    expect(en).toContain("section-heading mergecolor border-0");
    expect(en).toContain('href="/en/wallet"');
    expect(en).toContain('href="/en/servers/new"');
    expect(en).toContain("btn-default-yellow-fill");
    const bn = await render("bn");
    expect(bn).toContain("টপ আপ সম্পন্ন হয়েছে");
    expect(bn).toContain("৳১,৫০০.০০ যোগ হয়েছে। আপনার নতুন ব্যালেন্স ৳১,৫০০.০০।");
    expect(bn).toContain('href="/servers/new"');
  });

  it("credited never shows a balance that is not the live wallet balance", async () => {
    seed("credited", { balance: 777700n });
    const en = await render("en");
    expect(en).toContain("Your new balance is ৳7,777.00.");
    expect(en).not.toContain("Your new balance is ৳1,500.00.");
  });

  it("pending: waits, has the watcher and the no-JS 'Check again' button", async () => {
    for (const status of ["initiated", "redirected"]) {
      seed(status);
      const en = await render("en");
      expect(en).toContain("Checking your payment");
      expect(en).toContain("We are waiting for EPS to confirm. This page updates by itself.");
      expect(en).toContain('role="status" aria-live="polite"');
      expect(en).toContain("Checking…");
      expect(en).toContain("Check again");
      expect(en).toContain("fa-hourglass-half");
    }
    const bn = await render("bn");
    expect(bn).toContain("পেমেন্ট যাচাই হচ্ছে");
    expect(bn).toContain("আবার যাচাই করুন");
  });

  it("review: the sentence about the team and the reference, and no watcher", async () => {
    seed("review");
    const en = await render("en");
    expect(en).toContain("Your payment needs a check by our team. Contact support.");
    expect(en).toContain("Reference");
    expect(en).toContain("0190aaaa");
    expect(en).not.toContain("Checking…");
    const bn = await render("bn");
    expect(bn).toContain("আপনার পেমেন্ট আমাদের টিমের যাচাই দরকার। সাপোর্টের সাথে যোগাযোগ করুন।");
  });

  it("failed and cancelled: an alert with an icon, the state in words, 'You were not charged', and the way on", async () => {
    for (const [status, title] of [
      ["failed", "The payment did not go through"],
      ["cancelled", "The payment was cancelled"],
    ] as const) {
      seed(status);
      const en = await render("en");
      expect(en, status).toMatch(/alert alert-danger" role="alert"><i class="fas fa-[a-z-]+ me-2"/);
      expect(en, status).toContain(title);
      expect(en, status).toContain("You were not charged.");
      expect(en, status).toContain('href="/en/wallet/topup"');
      expect(en, status).toContain("Try again");
      expect(en, status).toContain("Back to wallet");
    }
    seed("failed");
    expect(await render("bn")).toContain("কোনো টাকা কাটা হয়নি।");
  });

  it("expired: asks the customer to quote the reference to support, and does not say 'not charged'", async () => {
    seed("expired");
    const en = await render("en");
    expect(en).toContain("The payment timed out");
    expect(en).toContain("If money left your account, tell support and quote this reference.");
    expect(en).not.toContain("You were not charged");
    expect(en).toContain("fa-exclamation-triangle");
    expect(en).toContain("Expired");
  });

  it("every state shows the amount, the date and the first 8 characters of the payment id, never the gateway's id", async () => {
    for (const status of ["credited", "redirected", "review", "failed", "cancelled", "expired"]) {
      seed(status);
      const en = await render("en");
      expect(en, status).toContain("৳1,500.00");
      expect(en, status).toContain("Amount");
      expect(en, status).toContain("Date");
      expect(en, status).toContain("0190aaaa");
      // The full id is in the paths of the language switch; it is never text on the page.
      expect(en.replace(/href="[^"]*"/g, ""), status).not.toContain("0190aaaa-0000");
      expect(en, status).not.toContain(SECRET_MTID);
    }
  });
});

describe("the status page: tenancy and URL (R6, R8)", () => {
  it("another customer's payment id is 'not found', the same as an unknown one", async () => {
    seed("credited", { customerId: OTHER });
    await expect(render("en")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("en", "0190aaaa-0000-7000-8000-0000000000ff")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("a malformed id is not found before the database is read", async () => {
    await expect(render("en", "../../etc/passwd")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.loaded).toEqual([]);
  });

  it("the page takes no search params: ?topup=credited cannot change what is shown", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "page.tsx"), "utf8");
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("topup=");
  });

  it("without a session it redirects before reading the payment", async () => {
    state.panelRedirect = `/login?next=%2Fwallet%2Ftopup%2F${ID}`;
    await expect(render("bn")).rejects.toThrow("REDIRECT:/login");
    expect(state.loaded).toEqual([]);
  });

  it("an unknown locale is a missing page", async () => {
    await expect(render("fr" as Locale)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the status page: markup rules (U4, U11)", () => {
  it("has no inline style and no script of ours in any state or language", async () => {
    for (const status of ["credited", "redirected", "review", "failed", "cancelled", "expired"]) {
      seed(status);
      for (const locale of ["bn", "en"] as const) {
        const html = (await render(locale)).replace(
          /<script>addEventListener\("submit".*?<\/script>/s,
          "",
        );
        expect(html, `${status} ${locale}`).not.toContain(' style="');
        expect(html, `${status} ${locale}`).not.toContain("<script");
      }
    }
  });
});
