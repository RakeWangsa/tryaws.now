import { knownClasses } from "@tc/ui/class-inventory";
import { vendoredThemePresent } from "@tc/ui/theme-present";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";
import { opsEn } from "./messages/ops.en.ts";
import { opsBn } from "./messages/ops.ts";
import { planChangeEn } from "./messages/planchange.en.ts";
import { planChangeBn } from "./messages/planchange.ts";

// WPA-P2: /operations/resources/[id], the plan change state of a container service or a CDN, and the
// form that clears the failure mark. The page asks the guard first (the operations section), the loader
// gives a fixed state, and the form has a reason and no actor.
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const RES = "0191a000-0000-7000-8000-000000000011";
const APPLIED = "0191a000-0000-7000-8000-0000000000a1";
const PENDING = "0191a000-0000-7000-8000-0000000000b1";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  plan: undefined as unknown,
  loaded: [] as unknown[],
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
vi.mock("./server/customer-actions.ts", () => ({ customerDecisionAction: async () => {} }));
vi.mock("./server/ops-actions.ts", () => ({
  operationAction: async () => {},
  clearPlanChangeMarkAction: async () => {},
}));
vi.mock("./server/ops-data.ts", () => ({
  loadResourcePlan: async (_admin: unknown, id: string) => {
    state.loaded.push(id);
    return state.plan;
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

const { default: PlanPage } = await import("./app/[locale]/operations/resources/[id]/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const AT = new Date("2026-11-12T06:00:00Z");

function view(over: Record<string, unknown> = {}) {
  return {
    kind: "ok",
    value: {
      resourceId: RES,
      family: "container_service",
      state: "active",
      region: "ap-southeast-1",
      config: {
        appliedPlan: { productId: APPLIED },
        pendingPlan: { productId: PENDING },
        pendingPlanFailed: {
          code: "conflict",
          productId: PENDING,
          period: "2026-11-01T00:00:00.000Z",
        },
      },
      plans: [
        { productId: APPLIED, awsId: "nano_1_0", active: true },
        { productId: PENDING, awsId: "micro_1_0", active: false },
      ],
      operations: [
        {
          id: "0191a000-0000-7000-8000-0000000000c1",
          kind: "scale_container",
          state: "needs_attention",
          lastError: "conflict",
          createdAt: AT,
        },
      ],
      ...over,
    },
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
const params = (locale: string, id: string = RES, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, id }),
  searchParams: Promise.resolve(search),
});
const msgs = (locale: Locale): typeof planChangeEn =>
  (locale === "bn" ? planChangeBn : planChangeEn) as typeof planChangeEn;

beforeEach(() => {
  state.asked = [];
  state.loaded = [];
  as("ops");
  state.plan = view();
});

describe("/operations/resources/[id]", () => {
  it.each(LOCALES)(
    "shows the applied plan, the pending plan, the failure mark and the apply operation in %s",
    async (locale) => {
      const html = inProvider(await PlanPage(params(locale)), locale);
      const m = msgs(locale).AdminPlanChange;
      expect(html).toContain(m.title);
      expect(html).toContain(m.families.container_service);
      expect(html).toContain(m.states.active);
      expect(html).toContain("<code>nano_1_0</code>");
      expect(html).toContain("<code>micro_1_0</code>");
      expect(html).toContain(m.plans.offSale);
      expect(html).toContain(m.failed.title);
      expect(html).toContain(m.failed.code);
      expect(html).toContain(m.operations.title);
      // the stored code is shown as a fixed line, never as stored text
      const ops = (locale === "bn" ? opsBn : opsEn) as typeof opsEn;
      expect(html).toContain(ops.AdminOps.errors.conflict);
      expect(state.asked).toEqual([[locale, "operations"]]);
      expect(state.loaded).toEqual([RES]);
    },
  );

  it("the clear form has a reason, the resource and the form id; no actor, role or operation travels", async () => {
    const html = inProvider(await PlanPage(params("en")), "en");
    expect(html).toContain(`name="resourceId" value="${RES}"`);
    expect(html).toMatch(/name="requestId" value="[0-9a-f-]{36}"/);
    expect(html.match(/name="reason"/g)?.length).toBe(1);
    expect(html).toContain(msgs("en").AdminPlanChange.clear.submit);
    expect(html).not.toMatch(/name="(actor|adminId|role|approver|operationId)/);
  });

  it("every render gives the form its own id, so a second visit is a new request", async () => {
    const a = inProvider(await PlanPage(params("en")), "en");
    const b = inProvider(await PlanPage(params("en")), "en");
    const idOf = (h: string) => /name="requestId" value="([0-9a-f-]{36})"/.exec(h)?.[1];
    expect(idOf(a)).toBeDefined();
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it("an apply that is queued or running says so", async () => {
    state.plan = view({
      operations: [
        {
          id: "0191a000-0000-7000-8000-0000000000c2",
          kind: "change_cdn_bundle",
          state: "queued",
          lastError: null,
          createdAt: AT,
        },
      ],
    });
    const html = inProvider(await PlanPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminPlanChange.inFlight.title);
  });

  it("a clear that is already queued replaces the form", async () => {
    state.plan = view({
      operations: [
        {
          id: "0191a000-0000-7000-8000-0000000000c3",
          kind: "clear_plan_change_mark",
          state: "queued",
          lastError: null,
          createdAt: AT,
        },
      ],
    });
    const html = inProvider(await PlanPage(params("en")), "en");
    expect(html).toContain(msgs("en").AdminPlanChange.clear.pendingClear);
    expect(html).not.toContain('name="reason"');
  });

  it.each(LOCALES)(
    "no failure mark: the state is said and there is no form in %s",
    async (locale) => {
      state.plan = view({
        config: {
          appliedPlan: null,
          pendingPlan: { productId: PENDING },
          pendingPlanFailed: null,
        },
      });
      const html = inProvider(await PlanPage(params(locale)), locale);
      const m = msgs(locale).AdminPlanChange;
      expect(html).toContain(m.noMark.title);
      expect(html).toContain(m.plans.appliedNone);
      expect(html).not.toContain('name="reason"');
    },
  );

  it("an old mark (code only) and a plan that is not in the catalog read without breaking", async () => {
    state.plan = view({
      config: {
        appliedPlan: { productId: "0191a000-0000-7000-8000-0000000000ff" },
        pendingPlan: null,
        pendingPlanFailed: { code: "weird_code_from_nowhere" },
      },
      operations: [],
    });
    const html = inProvider(await PlanPage(params("en")), "en");
    const m = msgs("en").AdminPlanChange;
    expect(html).toContain(m.plans.unreadable);
    expect(html).toContain(m.failed.productUnknown);
    expect(html).toContain(m.failed.periodUnknown);
    expect(html).toContain(m.plans.pendingNone);
    expect(html).toContain(m.operations.empty);
    // an unknown code is one fixed line, and the stored text never reaches the page
    expect(html).not.toContain("weird_code_from_nowhere");
  });

  it("a superadmin may open it; the guard comes first and a refused role reads nothing (R9, R16)", async () => {
    as("superadmin");
    expect(inProvider(await PlanPage(params("en")), "en")).toContain(
      msgs("en").AdminPlanChange.title,
    );
    state.page = { kind: "denied" };
    state.loaded = [];
    const html = inProvider(await PlanPage(params("en")), "en");
    expect(state.loaded).toEqual([]);
    expect(html).not.toContain(msgs("en").AdminPlanChange.title);
  });

  it("the repository's refusal shows the neutral page, a missing resource is a 404", async () => {
    state.plan = { kind: "denied" };
    expect(inProvider(await PlanPage(params("en")), "en")).not.toContain(
      msgs("en").AdminPlanChange.title,
    );
    state.plan = { kind: "missing" };
    await expect(PlanPage(params("en"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a locale that is not ours and an id that is not a UUID are a 404 and read nothing", async () => {
    await expect(PlanPage(params("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(PlanPage(params("en", "nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.asked).toEqual([]);
    expect(state.loaded).toEqual([]);
  });

  it.each(LOCALES)("an unavailable store shows its state and no data in %s", async (locale) => {
    state.plan = { kind: "unavailable" };
    const html = inProvider(await PlanPage(params(locale)), locale);
    expect(html).toContain(msgs(locale).AdminPlanChange.unavailable.title);
    expect(html).not.toContain("nano_1_0");
  });

  it("shows a result code of ours and ignores one that is not", async () => {
    const ok = inProvider(await PlanPage(params("en", RES, { result: "conflict" })), "en");
    expect(ok).toContain(msgs("en").AdminPlanChange.result.conflict);
    const other = inProvider(
      await PlanPage(params("en", RES, { result: "<script>alert(1)</script>" })),
      "en",
    );
    expect(other).not.toContain("alert(1)");
  });

  it("shows no AWS account id or ARN, and no inline style (360px)", async () => {
    const html = inProvider(await PlanPage(params("en")), "en");
    // (a UUID ends in twelve digits here, so the account id pattern must not sit inside a word or a dash)
    expect(html).not.toMatch(/arn:aws|(?<![\w-])\d{12}(?![\w-])/);
    expect(html).not.toMatch(/\sstyle\s*=/);
  });

  it.skipIf(!vendoredThemePresent())("every class is in the theme", async () => {
    const html = inProvider(await PlanPage(params("en")), "en");
    const known = knownClasses();
    const unknown = new Set<string>();
    for (const attribute of html.matchAll(/class="([^"]*)"/g)) {
      for (const token of (attribute[1] ?? "").split(/\s+/)) {
        if (token !== "" && !known.has(token) && token !== "clear" && token !== "tc-skip-link") {
          unknown.add(token);
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
