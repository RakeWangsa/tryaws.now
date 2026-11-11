import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readCatalogProduct: (...args: unknown[]) => read(...args),
}));

import { createAdapterRegistry } from "./adapters";
import { linuxInstanceAdapter } from "./linux";
import { windowsInstanceAdapter } from "./windows";

const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => read.mockReset());

function fakeCtx(adapter: { parseConfig(input: unknown): unknown }, step: string | null = null) {
  const never = {
    lightsail: () => ({
      send: () => {
        throw new Error("AWS must not be reached");
      },
    }),
  };
  return {
    operation: {
      id: "op",
      kind: "create",
      step,
      attempt: 1,
      createdAt: new Date(),
      payload: {},
    },
    stepKey: "op:start",
    resource: {
      id: "11111111-2222-4333-8444-555555555555",
      customerId: CUSTOMER,
      family: "windows_instance",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: {},
    },
    config: adapter.parseConfig({ productId: PRODUCT, region: "ap-south-1", displayName: "x" }),
    account: { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" },
    region: "ap-south-1",
    access: never,
    env: "staging",
    clock: { now: () => new Date() },
    owned: async () => null,
  } as never;
}

describe("the Windows adapter in the registry", () => {
  it("sits next to the Linux adapter under its own family", () => {
    const registry = createAdapterRegistry([linuxInstanceAdapter(), windowsInstanceAdapter()]);
    expect(registry.get("linux_instance")?.family).toBe("linux_instance");
    expect(registry.get("windows_instance")?.family).toBe("windows_instance");
  });
});

describe("windows wiring", () => {
  it("refuses a product of another family, an inactive one or a missing one (R16)", async () => {
    const adapter = windowsInstanceAdapter();
    const ctx = fakeCtx(adapter);
    read.mockResolvedValueOnce({
      family: "linux_instance",
      awsId: "small_win_3_0",
      platform: "windows",
      active: true,
    });
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    read.mockResolvedValueOnce({
      family: "windows_instance",
      awsId: "small_win_3_0",
      platform: "linux",
      active: true,
    });
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    read.mockResolvedValueOnce(null);
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    expect(read).toHaveBeenCalledWith({}, PRODUCT);
  });

  it("never hands an instance over: the marker probe answers absent (R16)", async () => {
    const adapter = windowsInstanceAdapter();
    const ctx = fakeCtx(adapter, "verify_bootstrap");
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
