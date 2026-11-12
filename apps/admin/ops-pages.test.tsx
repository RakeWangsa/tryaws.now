import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import type { CapacityRow, OperationDetail, OperationQueueRow, WaitlistCount } from "@tc/db";
import type { Locale, Messages } from "@tc/ui/runtime";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminMessages } from "./i18n/messages.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const POOL_ID = "0191a000-0000-7000-8000-0000000000b1";
const OP_ID = "0191a000-0000-7000-8000-0000000000c1";
const RES_ID = "0191a000-0000-7000-8000-0000000000d1";
const LEAK = "AccessDenied arn:aws:iam::123456789012:role/TcProvisioner AKIAIOSFODNN7EXAMPLE";

type Page =
  { kind: "ok"; admin: { adminId: string; role: string; ip: string } } | { kind: "denied" };
type W<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: string };
const okW = <T,>(value: T): W<T> => ({ ok: true, value, replayed: false });

const state = vi.hoisted(() => ({
  page: undefined as unknown as Page,
  asked: [] as unknown[],
  counts: undefined as unknown,
  queues: {} as Record<string, unknown>,
  queueCalls: [] as unknown[],
  detail: undefined as unknown,
  overview: undefined as unknown,
  waitlist: undefined as unknown,
  pending: undefined as unknown,
  pendingCalls: [] as unknown[],
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
vi.mock("./server/ops-actions.ts", () => ({ operationAction: async () => {} }));
vi.mock("./server/capacity-actions.ts", () => ({ capacityAction: async () => {} }));
vi.mock("./server/money-actions.ts", () => ({ moneyAction: async () => {} }));
// The loaders are the real ones; only the transaction is replaced by the fake repositories.
vi.mock("./server/runtime.ts", () => ({
  readAsAdmin: async (_actor: unknown, fn: (repos: unknown) => Promise<unknown>) =>
    fn({
      operations: {
        counts: async () => state.counts,
        queue: async (filter: { state?: string }) => {
          state.queueCalls.push(filter);
          return state.queues[filter.state ?? "all"] ?? okW({ rows: [], nextAfter: null });
        },
        detail: async () => state.detail,
      },
      capacity: {
        overview: async () => state.overview,
        pending: async (input: unknown) => {
          state.pendingCalls.push(input);
          return state.pending;
        },
      },
      waitlist: { counts: async () => state.waitlist },
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

const { default: CapacityPage } = await import("./app/[locale]/capacity/page.tsx");
const { default: OperationsPage } = await import("./app/[locale]/operations/page.tsx");
const { default: OperationPage } = await import("./app/[locale]/operations/[id]/page.tsx");

const LOCALES: readonly Locale[] = ["bn", "en"];
const T0 = new Date("2026-11-10T06:00:00.000Z");

const opRow = (over: Partial<OperationQueueRow> = {}): OperationQueueRow => ({
  id: OP_ID,
  resourceId: RES_ID,
  kind: "destroy",
  state: "needs_approval",
  step: null,
  attempts: 0,
  destructive: true,
  needsApproval: true,
  approvedBy: null,
  nextRunAt: T0,
  createdAt: T0,
  lastError: null,
  family: "linux_instance",
  region: "ap-southeast-1",
  ...over,
});
const detail = (over: Partial<OperationDetail> = {}): OperationDetail => ({
  ...opRow(),
  trail: [],
  ...over,
});
const cell = (over: Partial<CapacityRow> = {}): CapacityRow => ({
  poolAccountId: POOL_ID,
  poolName: "tc-pool-a1",
  tier: "new",
  status: "active",
  region: "ap-southeast-1",
  quotaCode: "instance_vcpu",
  limit: 20,
  used: 15,
  reserve: 2,
  checkedAt: T0,
  ...over,
});
const wl = (over: Partial<WaitlistCount> = {}): WaitlistCount => ({
  productFamily: "linux_instance",
  region: "ap-southeast-1",
  reason: "capacity",
  open: 3,
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
const listParams = (locale: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(search),
});
const opParams = (locale: string, id = OP_ID, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ locale, id }),
  searchParams: Promise.resolve(search),
});
const counts = (over: Record<string, number> = {}) =>
  okW({
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    needs_approval: 1,
    needs_attention: 1,
    ...over,
  });

beforeEach(() => {
  state.asked = [];
  state.queueCalls = [];
  state.pendingCalls = [];
  state.counts = counts();
  state.queues = {
    needs_approval: okW({ rows: [opRow()], nextAfter: null }),
    needs_attention: okW({
      rows: [
        opRow({
          id: RES_ID,
          state: "needs_attention",
          kind: "reboot",
          destructive: false,
          lastError: LEAK,
          attempts: 5,
        }),
      ],
      nextAfter: null,
    }),
  };
  state.detail = okW(detail());
  state.overview = okW([cell(), cell({ quotaCode: "static_ip", limit: 5, used: 1 })]);
  state.waitlist = okW([wl()]);
  state.pending = okW(2);
  as("ops");
});

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("/capacity", () => {
  it("shows used against limit, the warning level, the edit form and the waitlist (bn and en)", async () => {
    for (const locale of LOCALES) {
      const html = inProvider(await CapacityPage(listParams(locale)), locale);
      const msgs = adminMessages[locale]["AdminCapacity"] as Record<string, Record<string, string>>;
      expect(html).toContain("tc-pool-a1");
      expect(html).toContain("15 / 20");
      expect(html).toContain(msgs["level"]?.["warning"]);
      expect(html).toContain('name="limit"');
      expect(html).toContain('value="setCapacityLimit"');
      expect(html).toContain("linux_instance");
      expect(html).toContain('value="notifyWaitlist"');
    }
  });

  it("never shows an AWS account id or an ARN", async () => {
    const html = inProvider(await CapacityPage(listParams("en")), "en");
    expect(html).not.toMatch(/\b\d{12}\b/);
    expect(html).not.toContain("arn:aws");
  });

  it("shows the recompute correction: live count plus pending, against the stored use", async () => {
    const search = { cell: `${POOL_ID}~ap-southeast-1~instance_vcpu`, live: "10" };
    const html = text(inProvider(await CapacityPage(listParams("en", search)), "en"));
    expect(state.pendingCalls).toEqual([
      { poolAccountId: POOL_ID, region: "ap-southeast-1", quotaCode: "instance_vcpu" },
    ]);
    expect(html).toContain("Use now: 15");
    expect(html).toContain("Units held: 2");
    expect(html).toContain("Corrected use: 12");
    expect(html).toContain("Change: -3");
  });

  it("drops a preview that is not ours and one with a live count that is not a whole number", async () => {
    for (const search of [
      { cell: "x~y~z", live: "10" },
      { cell: `${POOL_ID}~ap-southeast-1~instance_vcpu`, live: "1.5" },
      { cell: `${POOL_ID}~ap-southeast-1~free_money`, live: "1" },
    ]) {
      state.pendingCalls = [];
      const html = text(inProvider(await CapacityPage(listParams("en", search)), "en"));
      expect(state.pendingCalls).toEqual([]);
      expect(html).not.toContain("Corrected use");
    }
  });

  it("marks full and over-the-limit cells", async () => {
    state.overview = okW([
      cell({ used: 18, limit: 20, reserve: 2 }),
      cell({ quotaCode: "bucket", used: 25, limit: 20 }),
    ]);
    const html = text(inProvider(await CapacityPage(listParams("en")), "en"));
    expect(html).toContain("Full");
    expect(html).toContain("Over the limit");
  });

  it("a refusal of the repository (disabled admin, other role) shows no data", async () => {
    state.overview = { ok: false, error: "forbidden" };
    const html = inProvider(await CapacityPage(listParams("en")), "en");
    expect(html).not.toContain("tc-pool-a1");
    expect(html).not.toContain("linux_instance");
  });

  it("a failing database shows the fixed unavailable page, no text of the error", async () => {
    state.overview = { ok: false, error: "internal" };
    const html = inProvider(await CapacityPage(listParams("en")), "en");
    expect(html).toContain("Capacity could not be loaded");
  });

  it("a refusal by the guard shows no data (fail closed)", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await CapacityPage(listParams("en")), "en");
    expect(html).not.toContain("tc-pool-a1");
    expect(state.asked).toEqual([["en", "capacity"]]);
  });
});

describe("/operations", () => {
  it("shows the two queues with the destructive mark and the counts", async () => {
    for (const locale of LOCALES) {
      const html = inProvider(await OperationsPage(listParams(locale)), locale);
      const msgs = adminMessages[locale]["AdminOps"] as Record<string, Record<string, unknown>>;
      expect(html).toContain(
        (msgs["queue"] as Record<string, Record<string, string>>)["approval"]?.["title"],
      );
      expect(html).toContain(`/operations/${OP_ID}`);
      expect(html).toContain((msgs["queue"] as Record<string, string>)["destructive"]);
    }
  });

  it("maps the stored error to a fixed line: no AWS text, ARN or key reaches the page (R14)", async () => {
    for (const locale of LOCALES) {
      const html = inProvider(await OperationsPage(listParams(locale)), locale);
      expect(html).not.toContain("AccessDenied");
      expect(html).not.toContain("arn:aws");
      expect(html).not.toContain("AKIA");
      expect(html).not.toMatch(/\b\d{12}\b/);
    }
  });

  it("filters by state with the repository, and drops a state or kind that is not ours", async () => {
    state.queues["failed"] = okW({ rows: [opRow({ state: "failed" })], nextAfter: null });
    await OperationsPage(listParams("en", { state: "failed", kind: "destroy" }));
    expect(state.queueCalls).toEqual([{ state: "failed", kind: "destroy" }]);
    state.queueCalls = [];
    await OperationsPage(listParams("en", { state: "x'; drop", kind: "nope" }));
    expect(state.queueCalls.map((c) => (c as { state: string }).state).sort()).toEqual([
      "needs_approval",
      "needs_attention",
    ]);
  });

  it("a refusal of the repository shows no data", async () => {
    state.counts = { ok: false, error: "forbidden" };
    const html = inProvider(await OperationsPage(listParams("en")), "en");
    expect(html).not.toContain(OP_ID);
  });

  it("a failing database shows the fixed page", async () => {
    state.counts = { ok: false, error: "internal" };
    expect(inProvider(await OperationsPage(listParams("en")), "en")).toContain(
      "The operations could not be loaded",
    );
  });

  it("a refusal by the guard shows no data", async () => {
    state.page = { kind: "denied" };
    const html = inProvider(await OperationsPage(listParams("en")), "en");
    expect(html).not.toContain(OP_ID);
    expect(state.asked).toEqual([["en", "operations"]]);
  });
});

describe("/operations/[id]", () => {
  const forms = (html: string) =>
    [...html.matchAll(/name="kind" value="([A-Za-z]+)"/g)].map((m) => m[1]);

  it("offers approve and reject for an operation that waits for approval, and nothing else", async () => {
    const html = inProvider(await OperationPage(opParams("en")), "en");
    expect(forms(html)).toEqual(["approveOperation", "rejectOperation"]);
    expect(html).toContain('name="reason"');
  });

  it("has no field that names an approver", async () => {
    const html = inProvider(await OperationPage(opParams("en")), "en");
    expect(html).not.toMatch(/name="(?:approvedBy|approver|adminId|requester)"/i);
  });

  it("offers retry and reject for a stuck operation", async () => {
    state.detail = okW(
      detail({ state: "needs_attention", kind: "reboot", destructive: false, lastError: LEAK }),
    );
    const html = inProvider(await OperationPage(opParams("en")), "en");
    expect(forms(html)).toEqual(["rejectOperation", "retryOperation"]);
    expect(html).not.toContain("AccessDenied");
    expect(html).not.toContain("arn:aws");
  });

  it("offers no action for queued, running, waiting or failed operations: no cancel exists", async () => {
    for (const s of ["queued", "running", "waiting", "failed", "succeeded"]) {
      state.detail = okW(detail({ state: s as never, kind: "reboot", destructive: false }));
      const html = inProvider(await OperationPage(opParams("en")), "en");
      expect(forms(html)).toEqual([]);
      expect(html).toContain("An admin has no action in this state");
    }
  });

  // WPU-M4: the credit of a failed plan change, asked on the page of the operation by a superadmin.
  it("offers the credit of a failed plan change to a superadmin only, with a reason", async () => {
    for (const s of ["failed", "needs_attention"]) {
      state.detail = okW(
        detail({ state: s as never, kind: "scale_container", destructive: false }),
      );
      as("ops");
      expect(forms(inProvider(await OperationPage(opParams("en")), "en"))).not.toContain(
        "creditWalletForFailedChange",
      );
      as("superadmin");
      const html = inProvider(await OperationPage(opParams("en")), "en");
      expect(forms(html)).toContain("creditWalletForFailedChange");
      expect(html).toContain("Credit the wallet");
      expect(html).not.toMatch(/name="(?:amount|customerId|chargeId)"/);
      const bn = inProvider(await OperationPage(opParams("bn")), "bn");
      expect(bn).toContain("ওয়ালেটে ফেরত দিন");
    }
    // not for another kind or a state that is not failed
    as("superadmin");
    for (const [kind, st] of [
      ["reboot", "failed"],
      ["scale_container", "queued"],
      ["change_cdn_bundle", "succeeded"],
    ] as const) {
      state.detail = okW(detail({ state: st as never, kind, destructive: false }));
      expect(forms(inProvider(await OperationPage(opParams("en")), "en"))).not.toContain(
        "creditWalletForFailedChange",
      );
    }
  });

  it("offers no reject for a paid create that waits for approval", async () => {
    state.detail = okW(detail({ kind: "create", destructive: false }));
    const html = inProvider(await OperationPage(opParams("en")), "en");
    expect(forms(html)).toEqual(["approveOperation"]);
  });

  it("shows the trail of admin decisions", async () => {
    state.detail = okW(
      detail({
        state: "queued",
        approvedBy: ADMIN_ID,
        trail: [{ action: "operation.approve", actorId: ADMIN_ID, at: T0, reason: "phone call" }],
      }),
    );
    const html = inProvider(await OperationPage(opParams("en")), "en");
    expect(html).toContain("operation.approve");
    expect(html).toContain("phone call");
  });

  it("is a 404 for an id that is not a UUID or an operation that does not exist", async () => {
    await expect(OperationPage(opParams("en", "nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    state.detail = { ok: false, error: "not_found" };
    await expect(OperationPage(opParams("en"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a refusal of the repository or of the guard shows no data", async () => {
    state.detail = { ok: false, error: "forbidden" };
    expect(inProvider(await OperationPage(opParams("en")), "en")).not.toContain("linux_instance");
    state.page = { kind: "denied" };
    expect(inProvider(await OperationPage(opParams("en")), "en")).not.toContain("linux_instance");
  });
});

// The cross-check with the mockup: the classes of the rendered screens are the classes the theme
// pages use, and every class is defined by the theme, Bootstrap, Font Awesome or tc.css.
const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../..", "design/mockup/template");

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const attribute of html.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") tokens.add(token);
  }
  return tokens;
}
const mockup = (file: string) => classTokens(readFileSync(resolve(mockupRoot, file), "utf8"));

type Screen = "capacity" | "operations" | "operation";
const ANCHORS: { screen: Screen; file: string; classes: string[]; why: string }[] = [
  {
    screen: "capacity",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each pool and the waitlist are the card of the checkout page",
  },
  {
    screen: "capacity",
    file: "cart.html",
    classes: ["table-responsive-lg", "table", "compare", "seccolor"],
    why: "the cells of a pool are the table of the cart page",
  },
  {
    screen: "capacity",
    file: "elements.html",
    classes: ["cd-filter-block", "cd-filter-content"],
    why: "the limit form is the form block of the elements page",
  },
  {
    screen: "capacity",
    file: "payments.html",
    classes: ["badge", "bg-purple"],
    why: "the level and the status are badges of the payments page",
  },
  {
    screen: "operations",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "each queue is the card of the checkout page",
  },
  {
    screen: "operations",
    file: "cart.html",
    classes: ["table-responsive-lg", "compare", "seccolor"],
    why: "the queue is the table of the cart page",
  },
  {
    screen: "operations",
    file: "elements.html",
    classes: ["cd-filter-block", "form-control"],
    why: "the filter is the form block of the elements page",
  },
  {
    screen: "operations",
    file: "payments.html",
    classes: ["badge"],
    why: "the state is a badge of the payments page",
  },
  {
    screen: "operation",
    file: "checkout.html",
    classes: ["sec-main", "sec-bg1", "bg-seccolorstyle", "noshadow", "mergecolor"],
    why: "the facts and the decisions are the card of the checkout page",
  },
  {
    screen: "operation",
    file: "elements.html",
    classes: ["cd-filter-block"],
    why: "the decision form is the form block of the elements page",
  },
  {
    screen: "operation",
    file: "payments.html",
    classes: ["badge"],
    why: "the state is a badge of the payments page",
  },
];

describe("the capacity and operations screens follow the mockup", () => {
  const render = async (screen: Screen, locale: Locale) => {
    as("ops");
    state.detail = okW(
      detail({
        trail: [{ action: "operation.approve", actorId: ADMIN_ID, at: T0, reason: "x" }],
      }),
    );
    if (screen === "capacity") return inProvider(await CapacityPage(listParams(locale)), locale);
    if (screen === "operations") {
      return inProvider(await OperationsPage(listParams(locale)), locale);
    }
    return inProvider(await OperationPage(opParams(locale)), locale);
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
    for (const screen of ["capacity", "operations", "operation"] as const) {
      for (const locale of LOCALES) {
        const unknown = [...classTokens(await render(screen, locale))].filter(
          (c) => !known.has(c) && c !== "clear" && c !== "tc-skip-link",
        );
        expect(unknown, `${screen} in ${locale}`).toEqual([]);
      }
    }
  });
});
