import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import type {
  AdjustmentRow,
  DiscrepancyRow,
  PaymentAdminDetail,
  PaymentListRow,
  WalletAdminDetail,
} from "@tc/db";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { moneyBn } from "./messages/money.ts";
import { moneyEn } from "./messages/money.en.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const OTHER_ID = "0191a000-0000-7000-8000-0000000000ae";
const CUSTOMER_ID = "0191a000-0000-7000-8000-0000000000c1";
const PAYMENT_ID = "0191a000-0000-7000-8000-0000000000f1";
const ADJ_ID = "0191a000-0000-7000-8000-0000000000a1";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  wallet: undefined as unknown,
  walletCalls: [] as unknown[],
  payments: undefined as unknown,
  searched: [] as unknown[],
  payment: undefined as unknown,
  discrepancies: undefined as unknown,
}));

vi.mock("./server/page-admin.ts", () => ({
  loadPageAdmin: async (locale: string, id: string) => {
    state.asked.push([locale, id]);
    return state.page;
  },
}));
vi.mock("./server/actions.ts", () => ({
  signInAction: async () => ({ error: null }),
  signOutAction: async () => {},
}));
vi.mock("./server/money-actions.ts", () => ({ moneyAction: async () => {} }));
// The loaders are the real ones; only the transaction is replaced by the fake repositories.
vi.mock("./server/runtime.ts", () => ({
  readAsAdmin: async (_actor: unknown, fn: (repos: unknown) => Promise<unknown>) =>
    fn({
      wallets: {
        detail: async (...args: unknown[]) => {
          state.walletCalls.push(args);
          return state.wallet;
        },
      },
      payments: {
        search: async (input: unknown) => {
          state.searched.push(input);
          return state.payments;
        },
        detail: async () => state.payment,
        discrepancies: async () => state.discrepancies,
      },
    }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    let node = adminMessages[locale === "en" ? "en" : "bn"] as Messages | string | undefined;
    for (const part of namespace.split("."))
      node = typeof node === "object" ? node[part] : undefined;
    return (key: string): string => {
      let value: Messages | string | undefined = node;
      for (const part of key.split("."))
        value = typeof value === "object" ? value[part] : undefined;
      if (typeof value !== "string") throw new Error(`missing ${namespace}.${key}`);
      return value;
    };
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { default: WalletPage } = await import("./app/[locale]/wallets/[customerId]/page.tsx");
const { default: PaymentsPage } = await import("./app/[locale]/payments/page.tsx");
const { default: PaymentPage } = await import("./app/[locale]/payments/[id]/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const T0 = new Date("2026-11-10T06:00:00.000Z");

const adjustment = (over: Partial<AdjustmentRow> = {}): AdjustmentRow => ({
  id: ADJ_ID,
  customerId: CUSTOMER_ID,
  direction: "credit",
  amountMinor: 7_000_000n,
  kind: "deposit",
  reason: "bank deposit slip 77",
  evidenceRef: "slip 77",
  requestedBy: OTHER_ID,
  approvedBy: null,
  status: "pending",
  ledgerTransactionId: null,
  createdAt: T0,
  ...over,
});

const wallet = (over: Partial<WalletAdminDetail> = {}): WalletAdminDetail => ({
  customerId: CUSTOMER_ID,
  currency: "BDT",
  balanceMinor: 123_456n,
  ledgerSumMinor: 123_456n,
  consistent: true,
  limitMinor: 500_000n,
  lines: [
    {
      entryId: "0191a000-0000-7000-8000-0000000000b1",
      transactionId: "0191a000-0000-7000-8000-0000000000b2",
      createdAt: T0,
      kind: "topup",
      referenceType: "payment",
      direction: "credit",
      amountMinor: 123_456n,
      balanceAfterMinor: 123_456n,
    },
  ],
  nextCursor: null,
  pending: [adjustment()],
  decided: [adjustment({ id: "0191a000-0000-7000-8000-0000000000a2", status: "approved" })],
  ...over,
});

const paymentRow = (over: Partial<PaymentListRow> = {}): PaymentListRow => ({
  id: PAYMENT_ID,
  customerId: CUSTOMER_ID,
  gateway: "eps",
  merchantTransactionId: "tcmt-0191a000-0000-7000",
  amountMinor: 50_000n,
  currency: "BDT",
  status: "review",
  createdAt: T0,
  verifiedAt: null,
  ...over,
});

const discrepancy = (over: Partial<DiscrepancyRow> = {}): DiscrepancyRow => ({
  id: "0191a000-0000-7000-8000-0000000000d1",
  kind: "payment",
  status: "open",
  createdAt: T0,
  paymentId: PAYMENT_ID,
  reason: "amount_mismatch",
  expectedMinor: 50_000n,
  gotMinor: 49_000n,
  ...over,
});

const detail = (over: Partial<PaymentAdminDetail> = {}): PaymentAdminDetail => ({
  ...paymentRow(),
  gatewayTransactionId: "EPS-12345",
  ledgerTransactionId: null,
  verifyPayload: { Status: "Success", TotalAmount: "490.00" },
  refund: null,
  discrepancies: [discrepancy()],
  ...over,
});

function inProvider(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={adminMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const as = (role: string, adminId = ADMIN_ID) => {
  state.page = { kind: "ok", admin: { adminId, role, ip: "203.0.113.5" } };
};
const walletParams = (locale: string, id = CUSTOMER_ID, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, customerId: id }),
  searchParams: Promise.resolve(search),
});
const listParams = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const paymentParams = (locale: string, id = PAYMENT_ID, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, id }),
  searchParams: Promise.resolve(search),
});
const msgs = (locale: Locale) => (locale === "en" ? moneyEn.AdminMoney : moneyBn.AdminMoney);
const ok = <T,>(value: T) => ({ ok: true, value, replayed: false });

beforeEach(() => {
  as("finance");
  state.asked = [];
  state.wallet = ok(wallet());
  state.walletCalls = [];
  state.payments = ok({ rows: [paymentRow()], nextAfter: null });
  state.searched = [];
  state.payment = ok(detail());
  state.discrepancies = ok([discrepancy()]);
});

describe("/wallets/[customerId]", () => {
  it.each(LOCALES)(
    "finance sees the balance, the ledger with the running balance and the forms (%s)",
    async (locale) => {
      const html = inProvider(await WalletPage(walletParams(locale)), locale);
      expect(html).toContain(msgs(locale).wallet.ledgerCaption);
      expect(html).toContain(msgs(locale).wallet.kinds.topup);
      expect(html).toContain('name="kind" value="createAdjustment"');
      expect(html).toContain('name="amount"');
      expect(html).toContain('name="reason"');
      expect(html).toContain('name="kind" value="approveAdjustment"');
      expect(html).toContain('name="kind" value="rejectAdjustment"');
      expect(html).toContain(`name="customerId" value="${CUSTOMER_ID}"`);
      expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    },
  );

  it("asks the guard for the payments area", async () => {
    await WalletPage(walletParams("en"));
    expect(state.asked).toEqual([["en", "payments"]]);
  });

  it("the request id of the form is made at render and sent with it", async () => {
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    const ids = [
      ...html.matchAll(
        /name="kind" value="createAdjustment"\/><input type="hidden" name="id" value="([0-9a-f-]{36})"/g,
      ),
    ];
    expect(ids).toHaveLength(1);
  });

  it("the requester sees no approve or reject form for their own pending adjustment", async () => {
    state.wallet = ok(wallet({ pending: [adjustment({ requestedBy: ADMIN_ID })] }));
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    expect(html).not.toContain('value="approveAdjustment"');
    expect(html).not.toContain('value="rejectAdjustment"');
    expect(html).toContain(msgs("en").adjust.own);
  });

  it("superadmin approves but cannot create; the form is not shown", async () => {
    as("superadmin");
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    expect(html).not.toContain('value="createAdjustment"');
    expect(html).toContain('value="approveAdjustment"');
    expect(html).toContain(msgs("en").adjust.readOnly);
  });

  it("shows when no limit is set and warns when the cache and the ledger differ", async () => {
    state.wallet = ok(wallet({ limitMinor: 0n, consistent: false, ledgerSumMinor: 1n }));
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    expect(html).toContain(msgs("en").wallet.noLimit);
    expect(html).toContain(msgs("en").wallet.inconsistent);
  });

  it("passes only a cursor of ours to the repository", async () => {
    await WalletPage(walletParams("en", CUSTOMER_ID, { cursor: "x'; drop table wallets;--" }));
    await WalletPage(walletParams("en", CUSTOMER_ID, { cursor: `1700000000000000.${ADJ_ID}` }));
    expect(state.walletCalls).toEqual([
      [CUSTOMER_ID, {}],
      [CUSTOMER_ID, { cursor: `1700000000000000.${ADJ_ID}` }],
    ]);
  });

  it("shows the result code and ignores one that is not ours", async () => {
    const shown = inProvider(
      await WalletPage(walletParams("en", CUSTOMER_ID, { result: "conflict" })),
      "en",
    );
    expect(shown).toContain(msgs("en").result.conflict);
    const bad = inProvider(
      await WalletPage(walletParams("en", CUSTOMER_ID, { result: "<script>x</script>" })),
      "en",
    );
    expect(bad).not.toContain("<script>x");
    expect(bad).not.toContain('role="status"');
  });

  it("a malformed id and a missing wallet are 404; an unavailable store shows its state", async () => {
    await expect(WalletPage(walletParams("en", "nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.wallet = { ok: false, error: "not_found" };
    await expect(WalletPage(walletParams("en"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.wallet = { ok: false, error: "forbidden" };
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    expect(html).toContain(msgs("en").wallet.unavailable);
    expect(html).not.toContain("123");
  });

  it("a refusal by the guard shows no data (fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await WalletPage(walletParams("en")), "en");
    expect(html).not.toContain(msgs("en").wallet.ledgerCaption);
    expect(html).not.toContain('name="reason"');
  });

  it("an unknown locale is a 404", async () => {
    await expect(WalletPage(walletParams("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/payments", () => {
  it.each(LOCALES)(
    "lists payments with the state and the open discrepancies (%s)",
    async (locale) => {
      const html = inProvider(await PaymentsPage(listParams(locale)), locale);
      expect(html).toContain("tcmt-0191a000-0000-7000");
      expect(html).toContain(msgs(locale).payments.status.review);
      expect(html).toContain(msgs(locale).discrepancies.reasons.amount_mismatch);
      expect(html).toContain('name="kind" value="resolveDiscrepancy"');
      expect(html).toContain(`href="${locale === "en" ? "/en" : ""}/payments/${PAYMENT_ID}"`);
      expect(html).toContain(msgs(locale).payments.reviewNote);
    },
  );

  it("passes only values of ours to the search and drops the rest", async () => {
    await PaymentsPage(listParams("en", { q: "  tcmt-123456789 ", status: "review", after: "x" }));
    await PaymentsPage(
      listParams("en", { status: "'; drop table payments;--", after: PAYMENT_ID }),
    );
    await PaymentsPage(listParams("en", { status: "pending" }));
    expect(state.searched).toEqual([
      { q: "tcmt-123456789", status: "review" },
      { after: PAYMENT_ID },
      { status: "pending" },
    ]);
  });

  it("superadmin reads; an empty result and an unavailable store show their own states", async () => {
    as("superadmin");
    state.payments = ok({ rows: [], nextAfter: null });
    expect(inProvider(await PaymentsPage(listParams("en")), "en")).toContain(
      msgs("en").payments.empty.title,
    );
    state.payments = { ok: false, error: "forbidden" };
    const html = inProvider(await PaymentsPage(listParams("en")), "en");
    expect(html).toContain(msgs("en").payments.unavailable.title);
    expect(html).not.toContain("tcmt-");
  });

  it("asks the guard for the payments area and shows nothing when it refuses", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await PaymentsPage(listParams("en")), "en");
    expect(state.asked).toEqual([["en", "payments"]]);
    expect(html).not.toContain("tcmt-");
  });
});

describe("/payments/[id]", () => {
  it.each(LOCALES)(
    "shows the state, the safe payload and the forms for finance (%s)",
    async (locale) => {
      const html = inProvider(await PaymentPage(paymentParams(locale)), locale);
      expect(html).toContain("EPS-12345");
      expect(html).toContain("TotalAmount");
      expect(html).toContain('name="kind" value="reverifyPayment"');
      expect(html).toContain(msgs(locale).payment.refundOnlyCredited);
      expect(html).not.toContain('value="recordManualRefund"');
      expect(html).toContain(`/wallets/${CUSTOMER_ID}`);
    },
  );

  it("a credited payment offers the refund form, a refunded one does not", async () => {
    state.payment = ok(detail({ status: "credited", ledgerTransactionId: ADJ_ID }));
    const open = inProvider(await PaymentPage(paymentParams("en")), "en");
    expect(open).toContain('name="kind" value="recordManualRefund"');
    expect(open).not.toContain('value="reverifyPayment"');
    state.payment = ok(
      detail({
        status: "credited",
        refund: { transactionId: ADJ_ID, amountMinor: 10_000n, createdAt: T0 },
      }),
    );
    const done = inProvider(await PaymentPage(paymentParams("en")), "en");
    expect(done).not.toContain('value="recordManualRefund"');
    expect(done).toContain(msgs("en").payment.refundDone);
  });

  it("superadmin reads: no re-verify and no refund form", async () => {
    as("superadmin");
    const html = inProvider(await PaymentPage(paymentParams("en")), "en");
    expect(html).toContain(msgs("en").payment.readOnly);
    expect(html).not.toContain('value="reverifyPayment"');
    expect(html).not.toContain('value="recordManualRefund"');
  });

  it("a malformed id and a missing payment are 404; an unavailable store shows its state", async () => {
    await expect(PaymentPage(paymentParams("en", "nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.payment = { ok: false, error: "not_found" };
    await expect(PaymentPage(paymentParams("en"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.payment = { ok: false, error: "forbidden" };
    const html = inProvider(await PaymentPage(paymentParams("en")), "en");
    expect(html).toContain(msgs("en").payments.unavailable.title);
    expect(html).not.toContain("EPS-12345");
  });

  it("a refusal by the guard shows no data (fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await PaymentPage(paymentParams("en")), "en");
    expect(html).not.toContain("EPS-12345");
  });
});

// The cross-check with the mockup: the classes of the rendered screens are the classes the theme
// pages use, and every class is defined by the theme, Bootstrap, Font Awesome or tc.css.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../..", "design/mockup/template");

function classTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockup = (file: string) => classTokens(readFileSync(resolve(mockupRoot, file), "utf8"));

type Screen = "wallet" | "payments" | "payment";
const ANCHORS: { screen: Screen; file: string; classes: string[]; why: string }[] = [
  {
    screen: "wallet",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the wallet page is the card of the checkout page",
  },
  {
    screen: "wallet",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare"],
    why: "the ledger is the table of the cart page",
  },
  {
    screen: "wallet",
    file: "elements.html",
    classes: ["cd-filter-block", "cd-filter-content", "form-control"],
    why: "the adjustment form is the form block of the elements page",
  },
  {
    screen: "payments",
    file: "payments.html",
    classes: ["badge", "bg-purple", "sec-main", "bg-seccolorstyle", "noshadow"],
    why: "the payment list and its state badges are the payments page",
  },
  {
    screen: "payments",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare", "seccolor"],
    why: "the payment table is the table of the cart page",
  },
  {
    screen: "payments",
    file: "elements.html",
    classes: ["cd-filter-block", "form-control"],
    why: "the search form is the form block of the elements page",
  },
  {
    screen: "payment",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each block of the payment page is the card of the checkout page",
  },
  {
    screen: "payment",
    file: "payments.html",
    classes: ["badge"],
    why: "the state is a badge of the payments page",
  },
];

describe("the money screens follow the mockup", () => {
  const render = async (screen: Screen, locale: Locale) => {
    as("finance");
    state.payment = ok(detail({ status: "credited", ledgerTransactionId: ADJ_ID }));
    state.payments = ok({ rows: [paymentRow({ status: "credited" })], nextAfter: null });
    if (screen === "wallet") return inProvider(await WalletPage(walletParams(locale)), locale);
    if (screen === "payments") return inProvider(await PaymentsPage(listParams(locale)), locale);
    return inProvider(await PaymentPage(paymentParams(locale)), locale);
  };

  for (const anchor of ANCHORS) {
    it(`${anchor.screen} / ${anchor.file}: ${anchor.why}`, async () => {
      const inMockup = mockup(anchor.file);
      expect(
        anchor.classes.filter((c) => !inMockup.has(c)),
        `not in ${anchor.file}`,
      ).toEqual([]);
      for (const locale of LOCALES) {
        const tokens = classTokens(await render(anchor.screen, locale));
        expect(
          anchor.classes.filter((c) => !tokens.has(c)),
          `${anchor.screen} in ${locale}`,
        ).toEqual([]);
      }
    });
  }

  it("every class of the three screens is defined by the theme, Bootstrap, Font Awesome or tc.css", async () => {
    const known = knownClasses();
    for (const screen of ["wallet", "payments", "payment"] as const) {
      for (const locale of LOCALES) {
        const unknown = [...classTokens(await render(screen, locale))].filter(
          (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
        );
        expect(unknown, `${screen} in ${locale}`).toEqual([]);
      }
    }
  });
});
