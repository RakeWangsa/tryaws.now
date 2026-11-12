import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { usageSummary } from "@tc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import type {
  BillingScreen,
  SnapshotsScreen,
  StaticIpsScreen,
} from "../../../../server/account-view.ts";

// WPU-G5: the pages /snapshots, /static-ips and /billing in bn and en, with their ready, empty and
// flag-off states, the guard of the panel (R9 step 1) and the words of each state.
const state = vi.hoisted(() => ({
  snapshots: null as unknown,
  staticIps: null as unknown,
  billing: null as unknown,
  calls: [] as string[],
}));

vi.mock("next-intl/server", async () => {
  const { webMessages: messages } = await import("../../../../i18n/messages.ts");
  return {
    getTranslations: async (options?: { locale?: "bn" | "en" }) =>
      createTranslator({
        locale: options?.locale ?? "bn",
        messages: messages[options?.locale ?? "bn"],
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
    state.calls.push(`panel:${path}`);
    return {
      session: { customerId: "11111111-1111-4111-8111-111111111111" },
      displayName: "Rahim",
      balanceMinor: 150000n,
      market: { code: "BD", numerals: "latn" },
      enabledFamilies: ["cloudServers"],
      soonFamilies: [],
      unreadCount: 0,
    };
  },
}));
vi.mock("../../../../server/account-view.ts", () => ({
  loadSnapshots: async () => state.snapshots,
  loadStaticIps: async () => state.staticIps,
  loadBilling: async () => state.billing,
}));
vi.mock("../servers/[id]/actions.ts", () => ({
  createBackupAction: async () => ({}),
  deleteBackupAction: async () => ({}),
  restoreToNewServerAction: async () => ({}),
}));
vi.mock("../servers/[id]/manage-actions.ts", () => ({
  attachStaticIpAction: async () => ({}),
  detachStaticIpAction: async () => ({}),
}));

const { default: SnapshotsPage } = await import("../snapshots/page.tsx");
const { default: StaticIpsPage } = await import("../static-ips/page.tsx");
const { default: BillingPage } = await import("../billing/page.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

const S1 = "0190aaaa-0000-7000-8000-000000000001";
const B1 = "0190aaaa-0000-7000-8000-0000000000b1";
const BF = "0190aaaa-0000-7000-8000-0000000000bf";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const snapshotsReady: SnapshotsScreen = {
  state: "ready",
  requestId: REQ,
  servers: [{ id: S1, name: "web-1", region: "ap-southeast-1" }],
  groups: [
    {
      server: {
        id: S1,
        name: "web-1",
        region: "ap-southeast-1",
        state: "active",
        live: true,
        canSnapshot: true,
      },
      manual: 1,
      plans: [
        { id: "plan-1", region: "ap-southeast-1", priceMinor: 99_000n, specs: { diskGb: 40 } },
      ],
      items: [
        {
          id: B1,
          name: "before-upgrade",
          sizeGb: 40,
          createdAt: new Date("2026-11-01T00:00:00Z"),
          state: "active",
          final: false,
        },
        {
          id: BF,
          name: "",
          sizeGb: 40,
          createdAt: new Date("2026-10-01T00:00:00Z"),
          state: "active",
          final: true,
        },
      ],
    },
  ],
};

const staticReady: StaticIpsScreen = {
  state: "ready",
  requestId: REQ,
  items: [
    {
      serverId: S1,
      name: "web-1",
      region: "ap-southeast-1",
      address: "203.0.113.10",
      attached: true,
      serverState: "active",
      family: "linux_instance",
      busy: false,
      fee: { hourMinor: "74", charging: false },
    },
    {
      serverId: "0190aaaa-0000-7000-8000-000000000002",
      name: "db-host",
      region: "ap-south-1",
      address: null,
      attached: false,
      serverState: "stopped",
      family: "linux_instance",
      busy: true,
      fee: { hourMinor: "74", charging: true },
    },
  ],
};

const billingRows = [
  {
    resourceId: S1,
    name: "web-1",
    family: "linux_instance",
    status: "active",
    termDays: 30,
    periodEnd: new Date("2026-12-01T00:00:00Z"),
    autoRenew: false,
    amountMinor: 69_000n,
  },
];
const billingReady: BillingScreen = {
  state: "ready",
  balanceMinor: 150_000n,
  usage: usageSummary(billingRows),
  items: billingRows,
  lowBalance: true,
};

beforeEach(() => {
  state.calls.length = 0;
  state.snapshots = snapshotsReady;
  state.staticIps = staticReady;
  state.billing = billingReady;
});

describe("/snapshots", () => {
  it("renders in bn and en: the snapshot, the final one, restore and the create form", async () => {
    for (const locale of ["bn", "en"] as const) {
      const html = intl(await SnapshotsPage(params(locale)), locale);
      expect(html).toContain("before-upgrade");
      expect(html).toContain(locale === "bn" ? "স্ন্যাপশট" : "Snapshots");
      expect(html).toContain('name="restoreFromBackupId"');
      expect(html).toContain('name="serverId"');
      expect(html).toContain(`value="${REQ}"`);
      // The final snapshot has no delete button; only the manual one has.
      expect(html.match(/fa-trash-alt/g)?.length).toBe(1);
    }
    expect(state.calls).toContain("panel:/snapshots");
  });

  it("shows the sub-navigation of the server pages with the current page marked", async () => {
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).toContain("Static IPs");
    expect(html).toContain('href="/en/static-ips"');
  });

  it("flag off: the coming-soon state with no form (R12)", async () => {
    state.snapshots = { state: "flag_off" };
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).toContain("Cloud Servers are coming soon");
    expect(html).not.toContain("<form");
  });

  it("no server at all: an empty state that leads to the create form", async () => {
    state.snapshots = { state: "ready", requestId: REQ, servers: [], groups: [] };
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).toContain("You need a server before you can take a snapshot.");
    expect(html).toContain('href="/en/servers/new"');
  });

  it("servers but no snapshots: the empty state and the create form", async () => {
    state.snapshots = {
      state: "ready",
      requestId: REQ,
      servers: [{ id: S1, name: "web-1", region: "ap-southeast-1" }],
      groups: [],
    };
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).toContain("No snapshots yet");
    expect(html).toContain('name="name"');
  });

  it("a deleted server's final snapshot can still be restored but not deleted", async () => {
    const base = snapshotsReady.state === "ready" ? snapshotsReady.groups[0] : undefined;
    if (base === undefined) throw new Error("fixture");
    state.snapshots = {
      state: "ready",
      requestId: REQ,
      servers: [],
      groups: [
        {
          ...base,
          server: { ...base.server, state: "destroyed", live: false, canSnapshot: false },
          items: base.items.filter((i) => i.final),
          manual: 0,
        },
      ],
    };
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).toContain("This server was deleted");
    expect(html).toContain('name="restoreFromBackupId"');
    expect(html).not.toContain("fa-trash-alt");
  });

  it("an unknown locale is a 404", async () => {
    await expect(SnapshotsPage(params("xx"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows no AWS account id, ARN or generated name (U6)", async () => {
    const html = intl(await SnapshotsPage(params("en")), "en");
    expect(html).not.toMatch(/arn:aws|(?<![-\w])\d{12}(?![-\w])|\btc-[a-z]+-[0-9a-f]{6,}/);
  });
});

describe("/static-ips", () => {
  it("renders each server's static IP with attach or detach, in bn and en", async () => {
    for (const locale of ["bn", "en"] as const) {
      const html = intl(await StaticIpsPage(params(locale)), locale);
      expect(html).toContain("203.0.113.10");
      expect(html).toContain("db-host");
      expect(html).toContain(locale === "bn" ? "স্ট্যাটিক IP" : "Static IPs");
    }
    expect(state.calls).toContain("panel:/static-ips");
  });

  it("an attached IP offers detach with an acknowledgement; a detached one offers attach", async () => {
    const html = intl(await StaticIpsPage(params("en")), "en");
    expect(html).toContain('name="acknowledge"');
    expect(html).toContain("Attach static IP");
    // Distinct field ids per server on one page (U11).
    expect(html).toContain(`static-ip-ack-${S1}`);
  });

  it("a server with a change on its way has its buttons disabled and says why", async () => {
    const html = intl(await StaticIpsPage(params("en")), "en");
    expect(html).toContain("A change to this server is being applied");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Attach static IP/);
  });

  it("WPU-M1: says free while attached, the BDT price per hour after the first hour, and a badge once charging", async () => {
    const en = intl(await StaticIpsPage(params("en")), "en");
    expect(en).toContain("Free while attached");
    expect(en).toMatch(/Not attached: charged [^<]*0\.74[^<]* per hour after the first hour/);
    expect(en).toContain("Charging now");
    expect(en.match(/Charging now/g)).toHaveLength(1); // only the server whose free hour is over
    const bn = intl(await StaticIpsPage(params("bn")), "bn");
    // The numerals come from the market of the panel (the test panel has latn digits).
    expect(bn).toMatch(/0\.74|০\.৭৪/);
    expect(bn).toContain("চার্জ চলছে");
    expect(en).not.toMatch(/arn:aws|tc-staticip/);
  });

  it("flag off and empty states", async () => {
    state.staticIps = { state: "flag_off" };
    expect(intl(await StaticIpsPage(params("en")), "en")).toContain(
      "Cloud Servers are coming soon",
    );
    state.staticIps = { state: "ready", requestId: REQ, items: [] };
    const html = intl(await StaticIpsPage(params("en")), "en");
    expect(html).toContain("No static IPs");
    expect(html).not.toContain("<form");
  });

  it("an unknown locale is a 404", async () => {
    await expect(StaticIpsPage(params("xx"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/billing", () => {
  it("renders the balance, the cost of one term, the next renewal and the warnings in bn and en", async () => {
    for (const locale of ["bn", "en"] as const) {
      const html = intl(await BillingPage(params(locale)), locale);
      expect(html).toContain(locale === "bn" ? "বিলিং ও ব্যবহার" : "Billing and usage");
      expect(html).toContain("web-1");
      expect(html).toContain("alert-danger");
      expect(html).toContain("alert-warning");
    }
    expect(state.calls).toContain("panel:/billing");
  });

  it("shows the amounts in taka from paisa and links the wallet and the invoices", async () => {
    const html = intl(await BillingPage(params("en")), "en");
    expect(html).toContain("690.00");
    expect(html).toContain('href="/en/wallet"');
    expect(html).toContain('href="/en/invoices"');
  });

  it("without subscriptions: the empty state that leads to the create form", async () => {
    state.billing = {
      state: "ready",
      balanceMinor: 0n,
      usage: usageSummary([]),
      items: [],
      lowBalance: false,
    };
    const html = intl(await BillingPage(params("en")), "en");
    expect(html).toContain("No running services yet");
    expect(html).toContain('href="/en/servers/new"');
    expect(html).not.toContain("alert-danger");
  });

  it("an unknown locale is a 404", async () => {
    await expect(BillingPage(params("xx"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
