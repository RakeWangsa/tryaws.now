import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readCatalogProduct: (...args: unknown[]) => read(...args),
}));

import { bucketAdapter } from "./bucket";
import { containerServiceAdapter } from "./container";
import { createAdapterRegistry } from "./adapters";

const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = { customerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", productId: PRODUCT };

beforeEach(() => read.mockReset());

describe("the two adapters are registered by family", () => {
  it("bucket and container_service sit in the registry next to the others", () => {
    const registry = createAdapterRegistry([bucketAdapter(), containerServiceAdapter()]);
    expect(registry.get("bucket")?.family).toBe("bucket");
    expect(registry.get("container_service")?.family).toBe("container_service");
    expect(registry.get("database")).toBeUndefined();
  });
});

describe("bucket wiring", () => {
  it("gives the catalog bundle id of a bucket product and nothing for another family", async () => {
    const adapter = bucketAdapter();
    // The adapter is exercised through create's first step with a fake client elsewhere; here the
    // loader is reached through a minimal context that stops before AWS.
    read.mockResolvedValueOnce({ family: "linux_instance", awsId: "nano_3_0" });
    const ctx = fakeCtx(adapter);
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    expect(read).toHaveBeenCalledWith({}, PRODUCT);
    read.mockResolvedValueOnce(null);
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("container wiring", () => {
  it("refuses a product of another family or a surprising catalog row (R16)", async () => {
    const adapter = containerServiceAdapter();
    const ctx = fakeCtx(adapter);
    read.mockResolvedValueOnce({ family: "bucket", awsId: "micro", specs: { scale: 1 } });
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    read.mockResolvedValueOnce({ family: "container_service", awsId: "huge", specs: { scale: 1 } });
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
    read.mockResolvedValueOnce(null);
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({ code: "validation" });
  });
});

function fakeCtx(adapter: { parseConfig(input: unknown): unknown }) {
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
      step: null,
      attempt: 1,
      createdAt: new Date(),
      payload: {},
    },
    stepKey: "op:start",
    resource: {
      id: "11111111-2222-4333-8444-555555555555",
      customerId: input.customerId,
      family: "x",
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
