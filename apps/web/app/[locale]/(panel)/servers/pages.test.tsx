import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../i18n/messages.ts";
import {
  CUSTOMER_ID,
  SERVER_ID,
  configurator,
  detail,
  key,
  manage,
  order,
  server,
} from "./servers.fixtures.ts";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  panelRedirect: null as string | null,
  startPaths: [] as string[],
  loaderCalls: [] as unknown[][],
  servers: null as unknown,
  configurator: null as unknown,
  detail: null as unknown,
  manage: null as unknown,
  order: null as unknown,
  keys: null as unknown,
  runtime: null as unknown,
  verdict: null as unknown,
  balance: 150000n,
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
    state.startPaths.push(path);
    if (state.panelRedirect !== null) throw new Error(`REDIRECT:${state.panelRedirect}`);
    return {
      session: { customerId: "11111111-1111-4111-8111-111111111111" },
      displayName: "Rahim",
      balanceMinor: state.balance,
      market: { code: "BD", numerals: "beng" },
      enabledFamilies: ["cloudServers"],
      soonFamilies: [],
    };
  },
}));
vi.mock("../../../../server/servers-view.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/servers-view.ts")>();
  const record =
    (name: string, value: () => unknown) =>
    async (...args: unknown[]) => {
      state.loaderCalls.push([name, ...args]);
      return value();
    };
  return {
    ...actual,
    loadServers: record("servers", () => state.servers),
    loadConfigurator: record("configurator", () => state.configurator),
    loadServerDetail: record("detail", () => state.detail),
    loadOrder: record("order", () => state.order),
    loadSshKeys: record("keys", () => state.keys),
  };
});
// WP5-T6: the tabs of the detail page read their own loaders; the flag is off here, so the page keeps
// its first three tabs. The tabs have their own tests in ../_extras/.
vi.mock("../../../../server/extras-view.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../../server/extras-view.ts")>();
  return { ...actual, loadServerExtras: async () => ({ state: "flag_off" }) };
});
// WPU-G2: the header buttons and the Networking tab read their own loader and actions.
vi.mock("../../../../server/server-manage-view.ts", () => ({
  loadServerManage: async () => state.manage,
}));
vi.mock("./[id]/manage-actions.ts", () => ({
  rebootServerAction: async () => ({}),
  stopServerAction: async () => ({}),
  startServerAction: async () => ({}),
  renameServerAction: async () => ({}),
  addFirewallRuleAction: async () => ({}),
  removeFirewallRuleAction: async () => ({}),
  attachStaticIpAction: async () => ({}),
  detachStaticIpAction: async () => ({}),
}));
vi.mock("./[id]/actions.ts", () => ({
  attachDiskAction: async () => ({}),
  createBackupAction: async () => ({}),
  deleteBackupAction: async () => ({}),
  destroyDiskAction: async () => ({}),
  destroyServerAction: async () => ({}),
  detachDiskAction: async () => ({}),
  setAutoBackupAction: async () => ({}),
  setAutoRenewAction: async () => ({}),
  renewNowAction: async () => ({}),
  restoreToNewServerAction: async () => ({}),
  addDiskAction: async () => ({}),
}));
vi.mock("../../../../server/orders-runtime.ts", () => ({
  getOrdersRuntime: async () => state.runtime,
}));
vi.mock("@tc/core", async (importActual) => {
  const actual = await importActual<typeof import("@tc/core")>();
  return { ...actual, verifyDraft: () => state.verdict };
});
vi.mock("./new/actions.ts", () => ({ createOrderDraftAction: async () => ({}) }));
vi.mock("../orders/review/actions.ts", () => ({ placeOrderAction: async () => ({}) }));
vi.mock("../settings/ssh-keys/actions.ts", () => ({
  addSshKeyAction: async () => ({}),
  removeSshKeyAction: async () => ({}),
}));

const { default: ServersPage } = await import("./page.tsx");
const { default: NewServerPage } = await import("./new/page.tsx");
const { default: ServerDetailPage } = await import("./[id]/page.tsx");
const { default: ReviewPage } = await import("../orders/review/page.tsx");
const { default: OrderPage } = await import("../orders/[id]/page.tsx");
const { default: SshKeysPage } = await import("../settings/ssh-keys/page.tsx");

function intl(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}

const claims = {
  v: 1,
  c: CUSTOMER_ID,
  fam: "linux_instance",
  pid: "0190aaaa-0000-7000-8000-0000000000b1",
  region: "ap-south-1",
  cfg: { displayName: "web-1", keyPairId: null, productId: "x", region: "ap-south-1" },
  snap: {
    v: 1,
    currency: "BDT",
    pricedAt: "2026-11-12T00:00:00.000Z",
    awsPriceUsd: "5.0000",
    quantity: "1",
    fxRate: "120.0000",
    ruleVersion: "v1",
    baseMinor: "60000",
    steps: [{ code: "bd_vat", amountMinor: "9000" }],
    totalMinor: "69000",
  },
  iat: 1,
  exp: 4_000_000_000,
};

beforeEach(() => {
  state.locale = "bn";
  state.panelRedirect = null;
  state.startPaths = [];
  state.loaderCalls = [];
  state.servers = { state: "ready", servers: [server()] };
  state.configurator = configurator();
  state.detail = detail();
  state.manage = manage();
  state.order = order();
  state.keys = { state: "ready", keys: [key()] };
  state.runtime = {
    secrets: [new Uint8Array(32)],
    now: () => new Date("2026-11-12T00:00:00Z"),
    orders: {},
  };
  state.verdict = { ok: true, claims };
  state.balance = 150000n;
});

async function renderPage(
  page: (props: never) => Promise<ReactNode>,
  locale: Locale,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Promise<string> {
  state.locale = locale;
  const props = {
    params: Promise.resolve({ locale, ...params }),
    searchParams: Promise.resolve(query),
  } as never;
  return intl(await page(props), locale);
}

describe("/servers", () => {
  it("shows the server with its state, Region name and code, in bn and in en", async () => {
    const bn = await renderPage(ServersPage as never, "bn");
    expect(bn).toContain("ক্লাউড সার্ভার");
    expect(bn).toContain("web-1");
    expect(bn).toContain("Asia Pacific (Mumbai) · ap-south-1");
    expect(bn).toContain("চালু");
    expect(bn).toContain(`href="/servers/${SERVER_ID}"`);
    const en = await renderPage(ServersPage as never, "en");
    expect(en).toContain("Running");
    expect(en).toContain('href="/en/servers/new"');
  });

  it("shows the empty state with one button, and the flag-off state without a buying action", async () => {
    state.servers = { state: "ready", servers: [] };
    expect(await renderPage(ServersPage as never, "bn")).toContain("এখনও কোনো সার্ভার নেই");
    state.servers = { state: "flag_off" };
    const off = await renderPage(ServersPage as never, "en");
    expect(off).toContain("Cloud Servers are coming soon");
    expect(off).not.toContain("/servers/new");
  });

  it("reads the data for the session's customer only and redirects to the login without a session (R8, R16)", async () => {
    await renderPage(ServersPage as never, "bn");
    expect(state.loaderCalls[0]?.[0]).toBe("servers");
    expect((state.loaderCalls[0]?.[1] as { customerId: string }).customerId).toBe(CUSTOMER_ID);
    state.panelRedirect = "/login?next=%2Fservers";
    await expect(renderPage(ServersPage as never, "bn")).rejects.toThrow("REDIRECT:/login");
  });

  it("answers a locale that is not bn or en as a missing page", async () => {
    await expect(renderPage(ServersPage as never, "fr" as never)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/servers/new", () => {
  it("shows the Regions with name and code, plans with server-made prices, and the summary", async () => {
    const bn = await renderPage(NewServerPage as never, "bn");
    expect(bn).toContain("Asia Pacific (Singapore) · ap-southeast-1");
    expect(bn).toContain("৳৬৯০.০০");
    expect(bn).toContain("অর্ডারের সারাংশ");
    expect(bn).toContain('name="displayName"');
    expect(bn).toContain('name="keyPairId"');
    expect(bn).toContain("Cloud Server, built on Amazon Lightsail");
    const en = await renderPage(NewServerPage as never, "en");
    expect(en).toContain("Order summary");
  });

  it("shows what to do next when KYC is not verified, and the empty state without plans", async () => {
    state.configurator = { state: "kyc_required" };
    expect(await renderPage(NewServerPage as never, "en")).toContain("Verify your identity first");
    state.configurator = configurator({ plans: [], regions: [] });
    expect(await renderPage(NewServerPage as never, "bn")).toContain(
      "এখন কোনো প্ল্যান বিক্রির জন্য নেই",
    );
  });
});

describe("/servers/[id]", () => {
  it("shows the header and the three tabs, the SSH command and the key name", async () => {
    const bn = await renderPage(ServerDetailPage as never, "bn", { id: SERVER_ID });
    expect(bn).toContain("Amazon Lightsail instance");
    expect(bn).toContain("সারাংশ");
    expect(bn).toContain("অ্যাক্সেস");
    expect(bn).toContain("নেটওয়ার্কিং");
    expect(bn).toContain("ssh -i Laptop.pem ubuntu@203.0.113.10");
    expect(bn).toContain("Laptop");
    expect(state.loaderCalls[0]?.[2]).toBe(SERVER_ID);
  });

  it("answers another customer's server exactly like a missing one (R8)", async () => {
    state.detail = null;
    const foreign = await renderPage(ServerDetailPage as never, "bn", {
      id: "0190aaaa-0000-7000-8000-0000000000ff",
    });
    const missing = await renderPage(ServerDetailPage as never, "bn", { id: "nope" });
    expect(foreign).toContain("সার্ভারটি পাওয়া যায়নি");
    expect(foreign.replace(/0190aaaa[0-9a-f-]+/g, "ID")).toBe(missing.replace(/nope/g, "ID"));
  });

  it("never shows an account id, an ARN or a generated AWS name", async () => {
    const html = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(html).not.toMatch(/arn:aws|\b\d{12}\b|tc-instance/);
  });
});

describe("/servers/[id] management (WPU-G2)", () => {
  it("a running server has Reboot and Stop in the header, in Bengali first and in English", async () => {
    const bn = await renderPage(ServerDetailPage as never, "bn", { id: SERVER_ID });
    expect(bn).toContain("রিবুট");
    expect(bn).toContain("বন্ধ করুন");
    expect(bn).not.toContain("চালু করুন");
    expect(bn).toContain('name="requestId"');
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("Reboot");
    expect(en).toContain("A stopped server is still billed for its plan.");
  });
  it("a stopped server has Start, not Reboot", async () => {
    state.detail = detail({ state: "stopped" });
    state.manage = manage({ state: "stopped" });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("Start");
    expect(en).not.toContain("Reboot");
  });
  it("a server being created has no power buttons", async () => {
    state.detail = detail({ state: "creating" });
    state.manage = manage({ state: "creating" });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).not.toContain("Reboot");
  });
  it("the Connect tab shows the real login user, the key file of the customer's key and a correct command", async () => {
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("ssh -i Laptop.pem ubuntu@203.0.113.10");
    expect(en).toContain("Login user");
    expect(en).toContain("chmod 400 Laptop.pem");
    expect(en).not.toContain("&lt;user&gt;");
  });
  it("WPU-G13: the Connect tab names the image of the server and uses that image's login user", async () => {
    state.detail = detail({ imageName: "WordPress", loginUser: "bitnami" });
    state.manage = manage({ loginUser: "bitnami" });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("ssh -i Laptop.pem bitnami@203.0.113.10");
    expect(en).toContain("WordPress");
    const bn = await renderPage(ServerDetailPage as never, "bn", { id: SERVER_ID });
    expect(bn).toContain("ssh -i Laptop.pem bitnami@203.0.113.10");
    expect(bn).toContain("ইমেজ");
  });
  it("an unknown image gets no guessed user", async () => {
    state.manage = manage({ loginUser: null });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).not.toContain("ssh -i Laptop.pem");
    expect(en).toContain("We could not tell the login user");
  });
  it("the Networking tab lists the rules with the SSH warning, an add form and the static IP panel", async () => {
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("Firewall rules of this server");
    expect(en).toContain("Any IPv4 address");
    expect(en).toContain("SSH (port 22) is open to every address");
    expect(en).toContain("Add a rule");
    expect(en).toContain("Detach static IP");
    expect(en).toContain("IPv6 is not switched on for these servers yet.");
    const bn = await renderPage(ServerDetailPage as never, "bn", { id: SERVER_ID });
    expect(bn).toContain("ফায়ারওয়াল নিয়ম");
    expect(bn).toContain("নিয়ম যোগ করুন");
  });
  it("a restricted SSH rule shows no warning; an empty list shows the empty state", async () => {
    state.manage = manage({
      rules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["203.0.113.7/32"] }],
      sshOpenToWorld: false,
    });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("203.0.113.7/32");
    expect(en).not.toContain("SSH (port 22) is open to every address");
    state.manage = manage({ rules: [], sshOpenToWorld: false });
    expect(await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID })).toContain(
      "All traffic from the internet to this server is blocked.",
    );
  });
  it("an unreadable list is an error, not an empty table", async () => {
    state.manage = manage({ rules: null, sshOpenToWorld: false });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("cannot be shown now");
    expect(en).not.toContain("Add a rule");
  });
  it("with an operation on its way the forms are inert and say why", async () => {
    state.manage = manage({ busy: true });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("A change to this server is being applied");
    expect(en).not.toMatch(
      /<button[^>]*type="submit"(?![^>]*disabled)[^>]*>\s*(<[^>]+>\s*)*Reboot/,
    );
  });
  it("a detached static IP offers Attach and no acknowledgement box", async () => {
    state.manage = manage({ staticIpAttached: false });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("Attach static IP");
    expect(en).not.toContain("I understand that the address will change");
  });
  it("WPU-M1: the Networking tab says an attached IP is free and what an unattached one costs per hour", async () => {
    const attached = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(attached).toContain("Free while attached");
    expect(attached).toMatch(/after the first hour/);
    expect(attached).toMatch(/0\.74/);
    expect(attached).not.toContain("Charging now");

    state.manage = manage({
      staticIpAttached: false,
      staticIpFee: { hourMinor: "74", charging: false },
    });
    const waiting = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(waiting).toMatch(/Not attached: charged [^<]*0\.74[^<]* per hour after the first hour/);
    expect(waiting).not.toContain("Charging now");

    state.manage = manage({
      staticIpAttached: false,
      staticIpFee: { hourMinor: "74", charging: true },
    });
    const running = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(running).toContain("Charging now");
    const bn = await renderPage(ServerDetailPage as never, "bn", { id: SERVER_ID });
    expect(bn).toMatch(/০\.৭৪/);
    expect(bn).toContain("চার্জ চলছে");

    state.manage = manage({
      staticIpAttached: false,
      staticIpFee: { hourMinor: null, charging: false },
    });
    const none = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(none).toContain("price is not available");
  });
  it("with the flag off nothing can be changed and the page says so", async () => {
    state.manage = manage({ flagOn: false });
    const en = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(en).toContain("Managing this server is not open for you yet.");
    expect(en).not.toContain("Reboot");
    expect(en).not.toContain("Add a rule");
  });
  it("no inline style and no AWS names in the management markup", async () => {
    const html = await renderPage(ServerDetailPage as never, "en", { id: SERVER_ID });
    expect(html).not.toMatch(/ style=/);
    expect(html).not.toMatch(/arn:aws|tc-instance|tc-staticip/);
  });
});

describe("/orders/review", () => {
  it("shows the lines of the signed draft, the balance after the purchase and the terms box", async () => {
    const bn = await renderPage(ReviewPage as never, "bn", {}, { d: "payload.mac" });
    expect(bn).toContain("অর্ডার পর্যালোচনা");
    expect(bn).toContain("web-1");
    expect(bn).toContain("৳৬৯০.০০");
    expect(bn).toContain("৳৮১০.০০");
    expect(bn).toContain('name="idempotencyKey"');
    expect(bn).toContain("শর্তাবলি");
    expect(bn).not.toContain("alert-warning");
  });

  it("WPU-Z2: says auto-renew is on before the customer confirms, and prints no USD amount, in bn and en", async () => {
    // The signed draft prices 690 taka at 120 a dollar: the page has a USD text it must not print.
    const usdAmount = /\$\s*[\d০-৯]/;
    const bn = await renderPage(ReviewPage as never, "bn", {}, { d: "payload.mac" });
    expect(bn).toContain("স্বয়ংক্রিয় নবায়ন চালু আছে: এই মেয়াদ শেষ হলে পরবর্তী মেয়াদ");
    expect(bn).toContain("৳৬৯০.০০");
    expect(bn).not.toMatch(usdAmount);
    expect(bn).not.toContain("মার্কিন ডলারে মূল্য");
    const en = await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" });
    expect(en).toContain(
      "Auto-renew is on: the next period is paid from your wallet when this one ends. You can turn it off at any time on the Billing tab.",
    );
    expect(en).toContain("৳690.00");
    expect(en).not.toMatch(usdAmount);
    expect(en).not.toContain("Price in US dollars");
  });

  // WPU-Z2: only a Linux server is bought with auto-renew on. A domain (nothing renews the name at the
  // registry yet) and a family without a switch in the panel (a DNS zone, a database, a Windows server) are
  // bought with it off, so their review must not say it is on or point to a Billing tab.
  it.each(["domain", "dns_zone", "database", "windows_instance"])(
    "WPU-Z2: the review of a %s says nothing about auto-renew being on, in bn and en",
    async (fam) => {
      state.verdict = { ok: true, claims: { ...claims, fam } };
      const en = await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" });
      expect(en).toContain("৳690.00");
      expect(en).not.toContain("Auto-renew is on");
      expect(en).not.toContain("Billing tab");
      const bn = await renderPage(ReviewPage as never, "bn", {}, { d: "payload.mac" });
      expect(bn).toContain("৳৬৯০.০০");
      expect(bn).not.toContain("স্বয়ংক্রিয় নবায়ন চালু আছে");
      expect(bn).not.toContain("বিলিং ট্যাবে");
    },
  );

  it("shows the shortfall in whole taka and a top-up link that returns to the review (16.11 step 4)", async () => {
    state.balance = 50001n;
    const en = await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" });
    expect(en).toContain("Shortfall");
    expect(en).toContain(
      `href="/en/wallet/topup?amount=190&amp;next=${encodeURIComponent("/orders/review?d=payload.mac").replace(/&/g, "&amp;")}"`,
    );
  });

  it("shows the expired state and the invalid state in the platform's words", async () => {
    state.verdict = { ok: false, reason: "expired" };
    expect(await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" })).toContain(
      "The price has expired",
    );
    state.verdict = { ok: false, reason: "signature" };
    expect(await renderPage(ReviewPage as never, "bn", {}, { d: "x" })).toContain(
      "পর্যালোচনার লিংকটি ঠিক নয়",
    );
    expect(await renderPage(ReviewPage as never, "bn", {}, {})).toContain(
      "পর্যালোচনার লিংকটি ঠিক নয়",
    );
  });

  it("is unavailable and orders nothing when the draft secret is missing (R16)", async () => {
    state.runtime = null;
    expect(await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" })).toContain(
      "Ordering is not available right now",
    );
  });

  it("a token that names another customer is invalid, whatever the signature says", async () => {
    state.verdict = { ok: true, claims: { ...claims, c: "22222222-2222-4222-8222-222222222222" } };
    expect(await renderPage(ReviewPage as never, "en", {}, { d: "payload.mac" })).toContain(
      "This review link is not valid",
    );
  });
});

describe("/orders/[id]", () => {
  it("shows the steps and the progress message for each state of the operation", async () => {
    const creating = await renderPage(OrderPage as never, "bn", { id: "o1" });
    expect(creating).toContain("সার্ভার তৈরি হচ্ছে");
    state.order = order({ progress: "delayed" });
    expect(await renderPage(OrderPage as never, "en", { id: "o1" })).toContain(
      "Support is looking into it",
    );
    state.order = order({ progress: "failed" });
    expect(await renderPage(OrderPage as never, "en", { id: "o1" })).toContain(
      "returned to your wallet automatically",
    );
    state.order = order({ progress: "ready" });
    expect(await renderPage(OrderPage as never, "en", { id: "o1" })).toContain(
      `href="/en/servers/${SERVER_ID}"`,
    );
  });

  it("answers a missing or foreign order with one not-found state", async () => {
    state.order = null;
    expect(await renderPage(OrderPage as never, "en", { id: "o1" })).toContain("Order not found");
  });
});

describe("/settings/ssh-keys", () => {
  it("lists keys with fingerprints only and an add form; the key text is not echoed", async () => {
    const en = await renderPage(SshKeysPage as never, "en");
    expect(en).toContain("SHA256:abcdefghijklmnop");
    expect(en).toContain('name="publicKey"');
    expect(en).not.toContain("ssh-ed25519 AAAA");
    const bn = await renderPage(SshKeysPage as never, "bn");
    expect(bn).toContain("এসএসএইচ কী");
  });

  it("shows the empty and the flag-off states", async () => {
    state.keys = { state: "ready", keys: [] };
    expect(await renderPage(SshKeysPage as never, "en")).toContain("No SSH keys");
    state.keys = { state: "flag_off" };
    expect(await renderPage(SshKeysPage as never, "bn")).toContain("এসএসএইচ কী শিগগিরই আসছে");
  });
});
