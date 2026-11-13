import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resource: null as unknown,
  flag: true as boolean | null,
  operations: [] as unknown[],
  image: null as unknown,
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: () => ({
    profile: { get: async () => ({ market: "BD" }) },
    resources: { get: async () => state.resource },
    operations: { listForResource: async () => state.operations },
  }),
  readFeatureFlag: async () => state.flag,
  readImage: async () => state.image,
}));

vi.mock("@tc/core", async (original) => ({
  ...(await original<typeof import("@tc/core")>()),
  staticIpHourPrice: async () => ({ ok: true, value: { unit: "hour", perHourMinor: 74n } }),
}));

const { loadServerManage } = await import("./server-manage-view.ts");

const session = { customerId: "11111111-1111-4111-8111-111111111111" } as never;
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const resource = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  family: "linux_instance",
  state: "active",
  config: { displayName: "web-1" },
  ...over,
});

beforeEach(() => {
  state.resource = resource();
  state.flag = true;
  state.operations = [];
  state.image = null;
});

describe("loadServerManage", () => {
  it("a new Linux server has the default SSH rule, its static IP, the Ubuntu user and no work on its way", async () => {
    expect(await loadServerManage(session, "x", REQ)).toEqual({
      flagOn: true,
      requestId: REQ,
      state: "active",
      rules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] }],
      sshOpenToWorld: true,
      staticIpAttached: true,
      staticIpFee: { hourMinor: "74", charging: false },
      loginUser: "ubuntu",
      busy: false,
    });
  });
  it("WPU-G13: the login user is the one of the image the server was ordered with", async () => {
    state.resource = resource({ region: "ap-southeast-1", config: { blueprintId: "wordpress" } });
    // No synced row: the table of names answers.
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: "bitnami" });
    state.resource = resource({
      region: "ap-southeast-1",
      config: { blueprintId: "amazon_linux_2023" },
    });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: "ec2-user" });
    // A synced row wins over the table.
    state.image = {
      awsId: "amazon_linux_2023",
      region: "ap-southeast-1",
      active: true,
      specs: { name: "Amazon Linux", kind: "os", loginUser: "ec2-user" },
    };
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: "ec2-user" });
    // A value in the config that is not an image id is ignored: the default image.
    state.image = null;
    state.resource = resource({ config: { blueprintId: "Ubuntu; rm -rf" } });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: "ubuntu" });
    // An image nobody knows has no guessed user.
    state.resource = resource({ config: { blueprintId: "brand_new_thing" } });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: null });
    // WPU-Z19: the user GetInstance reported wins (a Lightsail-packaged app logs in as admin, not bitnami).
    state.resource = resource({ config: { blueprintId: "wordpress", loginUser: "admin" } });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: "admin" });
  });
  it("reads the saved rules, a detached IP and a restricted SSH rule", async () => {
    state.resource = resource({
      config: {
        staticIpAttached: false,
        firewallRules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["203.0.113.7/32"] }],
      },
    });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({
      staticIpAttached: false,
      sshOpenToWorld: false,
    });
  });
  it("a saved list that cannot be read is null, not a guess", async () => {
    state.resource = resource({ config: { firewallRules: "all" } });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({
      rules: null,
      sshOpenToWorld: false,
    });
  });
  it("Windows has no Linux user; the flag off and a missing or foreign family answer as they should (R12, R8)", async () => {
    state.resource = resource({ family: "windows_instance" });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ loginUser: null });
    state.flag = null;
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ flagOn: false });
    state.resource = resource({ family: "disk" });
    expect(await loadServerManage(session, "x", REQ)).toBeNull();
    state.resource = null;
    expect(await loadServerManage(session, "x", REQ)).toBeNull();
  });
  it("busy only for a conflicting operation that has not finished", async () => {
    state.operations = [
      { kind: "reboot", state: "succeeded" },
      { kind: "create_backup", state: "running" },
    ];
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ busy: false });
    state.operations = [{ kind: "set_ports", state: "queued" }];
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({ busy: true });
  });
});

describe("WPU-M1: the charge of an unattached static IP", () => {
  it("is running once the IP has been unattached for more than an hour", async () => {
    state.resource = resource({
      config: { staticIpAttached: false, detachedAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({
      staticIpAttached: false,
      staticIpFee: { hourMinor: "74", charging: true },
    });
    state.resource = resource({
      config: { staticIpAttached: false, detachedAt: new Date().toISOString() },
    });
    expect(await loadServerManage(session, "x", REQ)).toMatchObject({
      staticIpFee: { hourMinor: "74", charging: false },
    });
  });
});
