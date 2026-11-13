import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-G3 and WPU-G13 in the loaders of the server screens: the images the wizard offers per Region (active
// at AWS and switched on by an admin), and the login user of the image a server runs.
const state = vi.hoisted(() => ({
  flags: { linux_instance: true } as Record<string, boolean | null>,
  kyc: "verified",
  images: {} as Record<string, unknown[]>,
  switches: { state: "none" } as unknown,
  keys: [] as unknown[],
  resource: null as unknown,
  image: null as unknown,
  asked: [] as string[],
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: () => ({
    profile: { get: async () => ({ market: "BD", kycStatus: state.kyc }) },
    resources: { get: async () => state.resource, list: async () => [] },
    sshKeys: { list: async () => state.keys, get: async () => null },
  }),
  readFeatureFlag: async (_tx: unknown, key: string) => state.flags[key] ?? null,
  readCatalogProduct: async () => ({ specs: { vcpus: 2 } }),
  listCatalogProducts: async () => [
    {
      id: "p1",
      region: "ap-southeast-1",
      platform: "linux",
      specs: { vcpus: 2, power: 1000 },
      awsPriceUsd: "5",
      featureFlag: "linux_instance",
    },
    {
      id: "p2",
      region: "ap-south-1",
      platform: "linux",
      specs: { vcpus: 2 },
      awsPriceUsd: "5",
      featureFlag: "linux_instance",
    },
  ],
  listActiveImages: async (_tx: unknown, region: string) => {
    state.asked.push(region);
    return state.images[region] ?? [];
  },
  readImageSwitches: async () => state.switches,
  readImage: async () => state.image,
}));
vi.mock("@tc/core", async (importActual) => ({
  ...(await importActual<typeof import("@tc/core")>()),
  priceCatalog: async (_tx: unknown, rows: { id: string; region: string; specs: unknown }[]) => ({
    ok: true,
    value: rows.map((r) => ({ ...r, priceBdt: { totalMinor: 69000n } })),
  }),
}));

const { loadConfigurator, loadServerDetail } = await import("./servers-view.ts");

const session = { customerId: "11111111-1111-4111-8111-111111111111" } as never;
const now = () => new Date("2026-11-12T06:00:00Z");
const img = (id: string, kind: "os" | "app", name = id, loginUser: string | null = "x") => ({
  awsId: id,
  region: "ap-southeast-1",
  active: true,
  specs: { name, kind, group: null, version: null, loginUser },
});

beforeEach(() => {
  state.flags = { linux_instance: true };
  state.kyc = "verified";
  state.images = {};
  state.switches = { state: "none" };
  state.keys = [];
  state.resource = null;
  state.image = null;
  state.asked = [];
});

type Ready = Extract<Awaited<ReturnType<typeof loadConfigurator>>, { state: "ready" }>;

describe("loadConfigurator: the images of each Region", () => {
  it("offers the images that are on by default and drops the rest, with the logo file and the login user", async () => {
    state.images = {
      "ap-southeast-1": [
        img("ubuntu_24_04", "os", "Ubuntu", "ubuntu"),
        img("wordpress", "app", "WordPress", "bitnami"),
        img("amazon_linux_2023", "os", "Amazon Linux", "ec2-user"),
        img("some_new_app", "app"), // not on the default list
      ],
    };
    const screen = (await loadConfigurator(session, now)) as Ready;
    expect(screen.images["ap-southeast-1"]).toEqual([
      {
        id: "ubuntu_24_04",
        name: "Ubuntu",
        kind: "os",
        version: null,
        loginUser: "ubuntu",
        logo: "ubuntu",
        minPower: 0,
      },
      {
        id: "wordpress",
        name: "WordPress",
        kind: "app",
        version: null,
        loginUser: "bitnami",
        logo: "wordpress",
        minPower: 500, // an app with no known minimum: the default of the core (the 1 GB plan, WPU-Z19)
      },
      {
        id: "amazon_linux_2023",
        name: "Amazon Linux",
        kind: "os",
        version: null,
        loginUser: "ec2-user",
        logo: null,
        minPower: 0,
      },
    ]);
    // Each Region is asked for its own images; one with none has an empty list, not the other's.
    expect(screen.images["ap-south-1"]).toEqual([]);
    expect([...state.asked].sort()).toEqual(["ap-south-1", "ap-southeast-1"]);
  });

  it("WPU-G10: carries the minimum plan power of each image (AWS value, admin override) and the power of each plan", async () => {
    state.images = {
      "ap-southeast-1": [
        {
          ...img("wordpress", "app", "WordPress"),
          specs: { ...img("wordpress", "app").specs, minPower: 2000 },
        },
        img("nodejs", "app", "Node"),
        img("ubuntu_24_04", "os", "Ubuntu"),
      ],
    };
    state.switches = { state: "ok", switches: { on: [], off: [], minPower: { nodejs: 500 } } };
    const screen = (await loadConfigurator(session, now)) as Ready;
    const byId = Object.fromEntries(
      (screen.images["ap-southeast-1"] ?? []).map((i) => [i.id, i.minPower]),
    );
    expect(byId).toEqual({ wordpress: 2000, nodejs: 500, ubuntu_24_04: 0 });
    expect(screen.plans.map((p) => p.power)).toEqual([1000, null]);
  });

  it("follows the admin switches: an image switched on appears, a default one switched off goes", async () => {
    state.images = {
      "ap-southeast-1": [img("ubuntu_24_04", "os"), img("some_new_app", "app")],
    };
    state.switches = {
      state: "ok",
      switches: { on: ["some_new_app"], off: ["ubuntu_24_04"] },
    };
    const screen = (await loadConfigurator(session, now)) as Ready;
    expect(screen.images["ap-southeast-1"]?.map((i) => i.id)).toEqual(["some_new_app"]);
  });

  it("a stored allow-list that cannot be read offers nothing and reads no image row (R16)", async () => {
    state.images = { "ap-southeast-1": [img("ubuntu_24_04", "os")] };
    state.switches = { state: "invalid" };
    const screen = (await loadConfigurator(session, now)) as Ready;
    expect(Object.values(screen.images).flat()).toEqual([]);
    expect(state.asked).toEqual([]);
  });

  it("ignores a row whose specs are not what the sync writes", async () => {
    state.images = {
      "ap-southeast-1": [
        { awsId: "ubuntu_24_04", region: "ap-southeast-1", active: true, specs: null },
        { awsId: "debian_12", region: "ap-southeast-1", active: true, specs: { kind: "weird" } },
        img("ubuntu_22_04", "os"),
      ],
    };
    const screen = (await loadConfigurator(session, now)) as Ready;
    expect(screen.images["ap-southeast-1"]?.map((i) => i.id)).toEqual(["ubuntu_22_04"]);
  });

  it("the flag off and a customer without KYC get their states and read no images", async () => {
    state.flags = {};
    expect(await loadConfigurator(session, now)).toEqual({ state: "flag_off" });
    state.flags = { linux_instance: true };
    state.kyc = "pending";
    expect(await loadConfigurator(session, now)).toEqual({ state: "kyc_required" });
    expect(state.asked).toEqual([]);
  });
});

describe("loadServerDetail: the image and the login user of the server (WPU-G13)", () => {
  const server = (config: Record<string, unknown>) => ({
    id: "22222222-2222-4222-8222-222222222222",
    family: "linux_instance",
    state: "active",
    region: "ap-southeast-1",
    productId: "p1",
    config: { displayName: "web", publicIpv4: "203.0.113.10", ...config },
    createdAt: new Date("2026-11-10T00:00:00Z"),
  });

  it("names the image that was ordered and its login user, from the synced row", async () => {
    state.resource = server({ blueprintId: "wordpress" });
    state.image = img("wordpress", "app", "WordPress", "bitnami");
    expect(await loadServerDetail(session, "x")).toMatchObject({
      imageName: "WordPress",
      loginUser: "bitnami",
    });
  });

  it("falls back to the table of login users when the row is gone, and to nothing for an unknown image", async () => {
    state.resource = server({ blueprintId: "amazon_linux_2023" });
    expect(await loadServerDetail(session, "x")).toMatchObject({
      imageName: null,
      loginUser: "ec2-user",
    });
    state.resource = server({ blueprintId: "brand_new_thing" });
    expect(await loadServerDetail(session, "x")).toMatchObject({ loginUser: null });
  });

  it("WPU-Z19: the user GetInstance reported (stored by the provisioner) wins over the row and the table", async () => {
    state.resource = server({ blueprintId: "wordpress", loginUser: "admin" });
    state.image = img("wordpress", "app", "WordPress", "bitnami");
    expect(await loadServerDetail(session, "x")).toMatchObject({ loginUser: "admin" });
    // A stored value that is not a plain user name is ignored.
    state.resource = server({ blueprintId: "wordpress", loginUser: "root; rm -rf /" });
    expect(await loadServerDetail(session, "x")).toMatchObject({ loginUser: "bitnami" });
  });

  it("an older server (no image in its configuration) is the default image", async () => {
    state.resource = server({});
    expect(await loadServerDetail(session, "x")).toMatchObject({ loginUser: "ubuntu" });
  });

  it("another customer's server and a missing one answer the same: null (R8)", async () => {
    state.resource = null;
    expect(await loadServerDetail(session, "x")).toBeNull();
  });
});
