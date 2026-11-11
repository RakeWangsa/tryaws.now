import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  resource: null as unknown,
  flags: {} as Record<string, boolean | null>,
  resources: [] as unknown[],
};
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: () => ({
    profile: { get: async () => ({ market: "BD" }) },
    resources: { get: async () => state.resource, list: async () => state.resources },
    sshKeys: { get: async () => null, list: async () => [] },
  }),
  readFeatureFlag: async (_tx: unknown, key: string) => state.flags[key] ?? null,
  readCatalogProduct: async () => ({ specs: { vcpus: 2 } }),
  listCatalogProducts: async () => [],
}));
vi.mock("@tc/core", () => ({ priceCatalog: async () => ({ ok: true, value: [] }) }));

const { loadServerDetail, loadServers } = await import("./servers-view.ts");

const session = { customerId: "11111111-1111-4111-8111-111111111111" } as never;
const row = (family: string) => ({
  id: "22222222-2222-4222-8222-222222222222",
  family,
  state: "active",
  region: "ap-south-1",
  productId: "33333333-3333-4333-8333-333333333333",
  config: { displayName: "win-1", publicIpv4: "203.0.113.10" },
  createdAt: new Date("2026-11-10T00:00:00Z"),
});

beforeEach(() => {
  state.resource = null;
  state.flags = {};
  state.resources = [];
});

describe("loadServerDetail for a Windows server", () => {
  it("returns it with its family while its flag is on, with no key name", async () => {
    state.resource = row("windows_instance");
    state.flags = { windows_instance: true };
    expect(await loadServerDetail(session, "x")).toMatchObject({
      family: "windows_instance",
      name: "win-1",
      keyName: null,
    });
  });

  it("answers like a missing server when the flag is off, missing or unreadable (R12, R16)", async () => {
    state.resource = row("windows_instance");
    for (const flags of [{ windows_instance: false }, {}] as Record<string, boolean | null>[]) {
      state.flags = flags;
      expect(await loadServerDetail(session, "x")).toBeNull();
    }
  });

  it("still answers a Linux server and refuses another family or a missing row", async () => {
    state.resource = row("linux_instance");
    expect(await loadServerDetail(session, "x")).toMatchObject({ family: "linux_instance" });
    state.resource = row("database");
    expect(await loadServerDetail(session, "x")).toBeNull();
    state.resource = null;
    expect(await loadServerDetail(session, "x")).toBeNull();
  });
});

describe("loadServers", () => {
  it("lists each family only while its own flag is on", async () => {
    state.resources = [row("linux_instance"), { ...row("windows_instance"), id: "w" }];
    state.flags = { windows_instance: true };
    const only = await loadServers(session);
    expect(only.state === "ready" && only.servers.map((s) => s.id)).toEqual(["w"]);
    state.flags = {};
    expect(await loadServers(session)).toEqual({ state: "flag_off" });
  });
});
