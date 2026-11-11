import { beforeEach, describe, expect, it, vi } from "vitest";
import { enabledFamilies } from "./families.ts";

const state = vi.hoisted(() => ({
  locale: "bn" as "bn" | "en",
  session: null as null | { customerId: string },
  dbError: false,
  profile: { name: "Rahim", market: "BD" } as null | { name: string | null; market: string },
  wallet: { balanceMinor: 150000n, currency: "BDT" } as null | {
    balanceMinor: bigint;
    currency: string;
  },
  market: { code: "BD", currency: "BDT", locales: ["bn", "en"], numerals: "beng" } as null | {
    code: string;
    numerals: "beng" | "latn";
  },
  flags: [] as { key: string; enabled: boolean }[],
  runtimeCalls: 0,
  runtimeFails: false,
}));

vi.mock("@tc/auth", () => ({
  requireCustomer: async () => {
    if (state.session === null) throw new Error("unauthenticated");
    return state.session;
  },
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => {
    if (state.dbError) throw new Error("connection refused: postgres://user:pw@host");
    return fn({});
  },
  customerRepos: () => ({
    profile: { get: async () => state.profile },
    wallet: { view: async () => state.wallet },
    notifications: { unreadCount: async () => 3 },
  }),
  readMarketBasics: async () => state.market,
  readFeatureFlags: async () => state.flags,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => state.locale }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
// requireCustomer is configured by the runtime (configureAuth in runtime.ts): the panel builds it first.
vi.mock("./runtime.ts", () => ({
  getRuntime: async () => {
    state.runtimeCalls += 1;
    if (state.runtimeFails) throw new Error("web config: TC_STAGE is missing or unknown");
    return {};
  },
}));
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  // `cache` memoises per request in Next; a test makes one request per call.
  return { ...actual, cache: <T>(fn: T) => fn };
});

const { loadPanel, requirePanel, loginRedirect } = await import("./panel.ts");

const CUSTOMER = { customerId: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  state.locale = "bn";
  state.session = CUSTOMER;
  state.dbError = false;
  state.profile = { name: "Rahim", market: "BD" };
  state.wallet = { balanceMinor: 150000n, currency: "BDT" };
  state.market = { code: "BD", numerals: "beng" };
  state.flags = [];
  state.runtimeCalls = 0;
  state.runtimeFails = false;
});

describe("enabledFamilies: the twelve product flags to the seven navigation families", () => {
  it("maps each key to its family and drops the keys that have no entry of their own", () => {
    const table: [string, string][] = [
      ["linux_instance", "cloudServers"],
      ["windows_instance", "cloudServers"],
      ["database", "databases"],
      ["bucket", "objectStorage"],
      ["load_balancer", "loadBalancers"],
      ["container_service", "containers"],
      ["cdn", "cdn"],
      ["dns_zone", "domains"],
      ["domain", "domains"],
    ];
    for (const [key, family] of table) {
      expect(enabledFamilies([{ key, enabled: true }]), key).toEqual([family]);
      expect(enabledFamilies([{ key, enabled: false }]), key).toEqual([]);
    }
    for (const key of ["static_ip", "backup", "disk", "unknown_key"]) {
      expect(enabledFamilies([{ key, enabled: true }]), key).toEqual([]);
    }
  });

  it("lists a family once, in navigation order", () => {
    expect(
      enabledFamilies([
        { key: "domain", enabled: true },
        { key: "dns_zone", enabled: true },
        { key: "linux_instance", enabled: true },
        { key: "windows_instance", enabled: true },
      ]),
    ).toEqual(["cloudServers", "domains"]);
  });
});

describe("loadPanel", () => {
  it("builds the runtime (which configures the session check) before it asks for the session", async () => {
    await loadPanel("/wallet");
    expect(state.runtimeCalls).toBe(1);
  });

  it("a runtime that cannot be built refuses like a missing session (R16)", async () => {
    state.runtimeFails = true;
    const outcome = await loadPanel("/wallet");
    expect(outcome).toMatchObject({ ok: false, redirectTo: "/login?next=%2Fwallet" });
  });

  it("without a session redirects to the login with the path as next (bn and en)", async () => {
    state.session = null;
    expect(await loadPanel("/wallet")).toEqual({
      ok: false,
      redirectTo: "/login?next=%2Fwallet",
      locale: "bn",
    });
    state.locale = "en";
    expect(await loadPanel("/wallet")).toEqual({
      ok: false,
      redirectTo: "/en/login?next=%2Fwallet",
      locale: "en",
    });
  });

  it("a database error is a redirect, never an empty balance (R16), and holds no error text", async () => {
    state.dbError = true;
    const outcome = await loadPanel("/wallet");
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("postgres");
  });

  it("a customer without a profile or a market is refused", async () => {
    state.profile = null;
    expect((await loadPanel("/wallet")).ok).toBe(false);
    state.profile = { name: null, market: "BD" };
    state.market = null;
    expect((await loadPanel("/wallet")).ok).toBe(false);
  });

  it("gives the balance, the market digits and the families of the customer", async () => {
    state.flags = [{ key: "linux_instance", enabled: true }];
    const outcome = await loadPanel("/wallet");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.balanceMinor).toBe(150000n);
    expect(outcome.data.displayName).toBe("Rahim");
    expect(outcome.data.market).toEqual({ code: "BD", numerals: "beng" });
    expect(outcome.data.enabledFamilies).toEqual(["cloudServers"]);
    expect(outcome.data.soonFamilies).toEqual([]);
    expect(outcome.data.unreadCount).toBe(3);
  });

  it("a customer without a name has an empty display name, not an e-mail address", async () => {
    state.profile = { name: null, market: "BD" };
    const outcome = await loadPanel("/wallet");
    expect(outcome.ok && outcome.data.displayName).toBe("");
  });
});

describe("requirePanel and loginRedirect", () => {
  it("redirects through next/navigation when there is no session", async () => {
    state.session = null;
    await expect(requirePanel("/wallet")).rejects.toThrow("REDIRECT:/login?next=%2Fwallet");
  });

  it("drops a next that is not on the allow-list (U12)", () => {
    expect(loginRedirect("bn", "/wallet/topup?x=1")).toBe("/login?next=%2Fwallet%2Ftopup%3Fx%3D1");
    expect(loginRedirect("bn", "//evil.com")).toBe("/login");
    expect(loginRedirect("en", "/admin")).toBe("/en/login");
  });
});
