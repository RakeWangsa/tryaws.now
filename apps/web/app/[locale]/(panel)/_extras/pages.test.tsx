import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import { detail } from "../servers/servers.fixtures.ts";
import { dashboard, extras, metricsReady, notifications } from "./extras.fixtures.ts";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  enabled: ["cloudServers"] as string[],
  detail: null as unknown,
  screen: null as unknown,
  metrics: null as unknown,
  calls: [] as unknown[][],
  reader: null as unknown,
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
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("../../../../server/panel-page.ts", () => ({
  startPanelPage: async (path: string) => {
    state.calls.push(["panel", path]);
    return {
      session: { customerId: "11111111-1111-4111-8111-111111111111" },
      displayName: "Rahim",
      balanceMinor: 150000n,
      market: { code: "BD", numerals: "beng" },
      enabledFamilies: state.enabled,
      soonFamilies: [],
      unreadCount: 4,
    };
  },
}));
vi.mock("../../../../server/runtime.ts", () => ({
  getRuntime: async () => ({ config: { appOrigin: "https://panel.example.test" } }),
}));
vi.mock("../../../../server/servers-view.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/servers-view.ts")>();
  return { ...actual, loadServerDetail: async () => state.detail };
});
vi.mock("../../../../server/reader-port.ts", () => ({ getReaderPort: () => state.reader }));
vi.mock("../../../../server/extras-view.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/extras-view.ts")>();
  return {
    ...actual,
    loadServerExtras: async (...args: unknown[]) => {
      state.calls.push(["extras", ...args.slice(1)]);
      return state.screen;
    },
    loadMetrics: async (...args: unknown[]) => {
      state.calls.push(["metrics", args[1], args[2]]);
      return state.metrics;
    },
    loadDashboard: async () => state.calls.push(["dashboard"]) && dashboard(),
    loadNotifications: async () => state.calls.push(["notifications"]) && notifications(),
  };
});
vi.mock("../servers/[id]/actions.ts", () => ({
  attachDiskAction: async () => ({}),
  createBackupAction: async () => ({}),
  deleteBackupAction: async () => ({}),
  destroyDiskAction: async () => ({}),
  destroyServerAction: async () => ({}),
  detachDiskAction: async () => ({}),
  setAutoBackupAction: async () => ({}),
  setAutoRenewAction: async () => ({}),
}));
vi.mock("../notifications/actions.ts", () => ({ markNotificationsReadAction: async () => ({}) }));

const { default: DetailPage } = await import("../servers/[id]/page.tsx");
const { default: DashboardPage } = await import("../dashboard/page.tsx");
const { default: NotificationsPage } = await import("../notifications/page.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const ID = "0190aaaa-0000-7000-8000-0000000000a1";

beforeEach(() => {
  state.locale = "bn";
  state.enabled = ["cloudServers"];
  state.detail = detail();
  state.screen = { state: "ready", extras: extras() };
  state.metrics = metricsReady;
  state.calls = [];
  state.reader = null;
});

async function detailHtml(locale: Locale, query: Record<string, string> = {}) {
  const node = await DetailPage({
    params: Promise.resolve({ locale, id: ID }),
    searchParams: Promise.resolve(query),
  });
  return intl(node, locale);
}

describe("/servers/[id] with the tabs of WP5-T6", () => {
  it("shows the five new tabs in bn and en", async () => {
    expect(await detailHtml("bn")).toContain("ব্যাকআপ");
    const en = await detailHtml("en");
    for (const tab of ["Backups", "Storage", "Metrics", "Billing", "Destroy"]) {
      expect(en).toContain(`>${tab}<`);
    }
  });
  it("loads the extras and the metrics for the session's customer and the id of the path", async () => {
    await detailHtml("en", { range: "1w" });
    expect(state.calls).toContainEqual(["extras", ID, expect.any(String)]);
    expect(state.calls).toContainEqual(["metrics", ID, "1w"]);
  });
  it("opens the tab named in the query", async () => {
    expect(await detailHtml("en", { tab: "metrics" })).toMatch(
      /aria-selected="true"[^>]*>(?:[^<]*<[^>]+>)*[^<]*Metrics/,
    );
  });
  it("another customer's server (no extras) and a flag that is off keep the first three tabs", async () => {
    state.screen = { state: "ready", extras: null };
    const html = await detailHtml("en");
    expect(html).not.toContain(">Backups<");
    state.screen = { state: "flag_off" };
    expect(await detailHtml("en")).not.toContain(">Destroy<");
  });
  it("a missing server shows the not-found state and loads no extras", async () => {
    state.detail = null;
    const html = await detailHtml("en");
    expect(html).toContain("text-center");
    expect(state.calls.some((c) => c[0] === "extras")).toBe(false);
  });
});

describe("/dashboard and /notifications", () => {
  it("the dashboard renders in bn and en and asks for the panel of its own path", async () => {
    for (const locale of ["bn", "en"] as const) {
      const node = await DashboardPage({ params: Promise.resolve({ locale }) });
      const html = intl(node, locale);
      expect(html).toContain(locale === "bn" ? "ড্যাশবোর্ড" : "Dashboard");
    }
    expect(state.calls).toContainEqual(["panel", "/dashboard"]);
  });
  it("the dashboard shows the coming-soon state when no family is enabled (R12)", async () => {
    state.enabled = [];
    const node = await DashboardPage({ params: Promise.resolve({ locale: "en" }) });
    expect(intl(node, "en")).toContain("Cloud Servers are coming soon");
  });
  it("the bell shows the unread count of the panel on every page", async () => {
    const node = await NotificationsPage({ params: Promise.resolve({ locale: "en" }) });
    const html = intl(node, "en");
    expect(html).toContain("fa-bell");
    expect(html).toContain(">4<");
    expect(html).toContain("Your renewal is due");
  });
  it("an unknown locale is a 404", async () => {
    await expect(DashboardPage({ params: Promise.resolve({ locale: "xx" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
