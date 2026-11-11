import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readCatalogProduct: (...args: unknown[]) => read(...args),
}));

import { decideDestructive } from "@tc/core";
import { createAdapterRegistry } from "./adapters";
import { cdnAdapter } from "./cdn";

const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN = "99999999-8888-4777-8666-555555555555";
const CUSTOMER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => read.mockReset());

function ctx(
  adapter: { parseConfig(input: unknown): unknown },
  over: Record<string, unknown> = {},
) {
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
      customerId: CUSTOMER,
      family: "cdn",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: {},
    },
    config: adapter.parseConfig({
      productId: PRODUCT,
      region: "us-east-1",
      displayName: "x",
      originId: ORIGIN,
    }),
    account: { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" },
    region: "us-east-1",
    access: never,
    env: "staging",
    clock: { now: () => new Date() },
    owned: async () => null,
    ...over,
  } as never;
}

describe("cdn wiring (WP7-T2)", () => {
  it("is registered by family next to the others", () => {
    const registry = createAdapterRegistry([cdnAdapter()]);
    expect(registry.get("cdn")?.family).toBe("cdn");
    expect(registry.get("dns")).toBeUndefined();
  });

  it("reads the bundle from the catalog row of a cdn product, and refuses anything else (R16)", async () => {
    const adapter = cdnAdapter();
    read.mockResolvedValueOnce({ family: "bucket", awsId: "small_1_0" });
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({ code: "validation" });
    expect(read).toHaveBeenCalledWith({}, PRODUCT);
    read.mockResolvedValueOnce({ family: "cdn", awsId: "huge_9_9" });
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({ code: "validation" });
    read.mockResolvedValueOnce(null);
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({ code: "validation" });
  });
});

describe("destroy goes through the lifecycle guard: the settings are kept, no snapshot (R13, 11)", () => {
  const facts = (over: Record<string, unknown>) => ({
    subscriptionStatus: "retained",
    family: "cdn",
    hasFinalSnapshot: false,
    isFinalBackup: false,
    ...over,
  });
  it("allows a destroy of a retained CDN without a snapshot, and nothing else", () => {
    expect(decideDestructive("destroy", facts({}) as never)).toBe(true);
    expect(decideDestructive("destroy", facts({ subscriptionStatus: "active" }) as never)).toBe(
      false,
    );
    expect(decideDestructive("destroy", facts({ subscriptionStatus: "grace" }) as never)).toBe(
      false,
    );
  });
});
