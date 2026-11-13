import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { opsEn } from "./messages/ops.en.ts";
import { opsBn } from "./messages/ops.ts";
import { renewalsEn } from "./messages/renewals.en.ts";
import { renewalsBn } from "./messages/renewals.ts";

// WPU-X3 (b): /payments/renewals, the domain renewals stuck at the registry check, and the form of the admin action
// "registry confirmed not renewed". The page asks the guard of the payments section first (finance, superadmin), the
// loader gives a fixed state, and the form has the renewal, the form id and a reason: no actor, no role.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const OP = "0191a000-0000-7000-8000-000000000011";
const RES = "0191a000-0000-7000-8000-000000000012";
const CHECK = "0191a000-0000-7000-8000-000000000013";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  list: undefined as unknown,
  loaded: 0,
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
vi.mock("./server/ops-actions.ts", () => ({
  operationAction: async () => {},
  clearPlanChangeMarkAction: async () => {},
  confirmUnrenewedAction: async () => {},
}));
vi.mock("./server/ops-data.ts", () => ({
  loadStuckRenewals: async () => {
    state.loaded += 1;
    return state.list;
  },
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

const { default: RenewalsPage } = await import("./app/[locale]/payments/renewals/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const AT = new Date("2026-11-14T06:00:00Z");

function row(over: Record<string, unknown> = {}) {
  return {
    id: OP,
    resourceId: RES,
    domainName: "example.com",
    state: "needs_attention",
    step: "poll",
    attempts: 2,
    lastError: "upstream_unavailable",
    createdAt: AT,
    lastCheck: null,
    ...over,
  };
}

function inProvider(node: ReactElement, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={adminMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const as = (role: string) => {
  state.page = { kind: "ok", admin: { adminId: ADMIN_ID, role, ip: "203.0.113.7" } };
};
const params = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const msgs = (locale: Locale): typeof renewalsEn =>
  (locale === "bn" ? renewalsBn : renewalsEn) as typeof renewalsEn;
const ops = (locale: Locale): typeof opsEn => (locale === "bn" ? opsBn : opsEn) as typeof opsEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = 0;
  as("finance");
  state.list = { kind: "ok", value: [row()] };
});

describe("AdminRenewals messages", () => {
  it("bn and en have the same keys, no empty text and no forbidden wording", () => {
    expect(messageKeys(renewalsBn)).toEqual(messageKeys(renewalsEn));
    for (const tree of [renewalsBn, renewalsEn]) {
      const walk = (node: unknown): void => {
        if (typeof node === "string") expect(node.trim()).not.toBe("");
        else for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(tree);
    }
    expect(forbiddenWording(renewalsBn)).toEqual([]);
    expect(forbiddenWording(renewalsEn)).toEqual([]);
    for (const locale of LOCALES) expect(adminMessages[locale]["AdminRenewals"]).toBeDefined();
  });
});

describe("/payments/renewals", () => {
  it.each(LOCALES)("shows the stuck renewal and its fixed error line in %s", async (locale) => {
    const html = inProvider(await RenewalsPage(params(locale)), locale);
    const m = msgs(locale).AdminRenewals;
    expect(html).toContain(m.title);
    expect(html).toContain("example.com");
    expect(html).toContain(m.table.noCheck);
    expect(html).toContain(m.form.submit);
    expect(html).toContain(ops(locale).AdminOps.errors.upstream_unavailable);
    expect(state.asked).toEqual([[locale, "payments"]]);
  });

  it("the form has the renewal, the form id and one reason; no actor, role or approver travels", async () => {
    const html = inProvider(await RenewalsPage(params("en")), "en");
    expect(html).toContain(`name="id" value="${OP}"`);
    expect(html).toMatch(/name="requestId" value="[0-9a-f-]{36}"/);
    expect(html.match(/name="reason"/g)?.length).toBe(1);
    expect(html).not.toMatch(/name="(actor|adminId|role|approver|customerId)/);
  });

  it("the last check shows its outcome as a fixed line; a running check replaces the form", async () => {
    state.list = {
      kind: "ok",
      value: [
        row({
          lastCheck: {
            id: CHECK,
            state: "needs_attention",
            lastError: "expiry_changed",
            createdAt: AT,
          },
        }),
      ],
    };
    let html = inProvider(await RenewalsPage(params("en")), "en");
    expect(html).toContain(ops("en").AdminOps.errors.expiry_changed);
    expect(html).toContain('name="reason"');
    state.list = {
      kind: "ok",
      value: [row({ lastCheck: { id: CHECK, state: "queued", lastError: null, createdAt: AT } })],
    };
    html = inProvider(await RenewalsPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminRenewals.form.pending);
    expect(html).not.toContain('name="reason"');
  });

  it("stored text never reaches the page (R14)", async () => {
    state.list = {
      kind: "ok",
      value: [row({ lastError: "arn:aws:iam::123456789012:role/X secret", domainName: null })],
    };
    const html = inProvider(await RenewalsPage(params("en")), "en");
    expect(html).not.toContain("123456789012");
    expect(html).toContain(ops("en").AdminOps.errors.other);
    expect(html).toContain(msgs("en").AdminRenewals.table.unknownName);
  });

  it("no stuck renewal: the empty state and no form", async () => {
    state.list = { kind: "ok", value: [] };
    const html = inProvider(await RenewalsPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminRenewals.empty.title);
    expect(html).not.toContain('name="reason"');
  });

  it("shows the result of the action as a fixed line", async () => {
    const html = inProvider(await RenewalsPage(params("en", { result: "conflict" })), "en");
    expect(html).toContain(msgs("en").AdminRenewals.result.conflict);
  });

  it("a superadmin may open it; a refused role reads nothing (R9, R16)", async () => {
    as("superadmin");
    expect(inProvider(await RenewalsPage(params("en")), "en")).toContain(
      msgs("en").AdminRenewals.title,
    );
    state.page = { kind: "denied" };
    state.loaded = 0;
    const html = inProvider(await RenewalsPage(params("en")), "en");
    expect(state.loaded).toBe(0);
    expect(html).not.toContain(msgs("en").AdminRenewals.title);
  });

  it("the repository's refusal shows the neutral page; a database failure a fixed state", async () => {
    state.list = { kind: "denied" };
    expect(inProvider(await RenewalsPage(params("en")), "en")).not.toContain(
      msgs("en").AdminRenewals.form.submit,
    );
    state.list = { kind: "unavailable" };
    expect(inProvider(await RenewalsPage(params("en")), "en")).toContain(
      msgs("en").AdminRenewals.unavailable.title,
    );
  });
});
