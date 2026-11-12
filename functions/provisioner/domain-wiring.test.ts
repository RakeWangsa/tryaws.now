import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.fn();
const zoneHeld = vi.fn();
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  domainNameHolder: (...args: unknown[]) => holder(...args),
  hostedZoneHeldByOther: (...args: unknown[]) => zoneHeld(...args),
}));

import { decideDestructive } from "@tc/core";
import { createAdapterRegistry } from "./adapters";
import { domainAdapter } from "./domain";

const RESOURCE = "11111111-2222-4333-8444-555555555555";
const SEALED = Buffer.from("x".repeat(12)).toString("base64");

beforeEach(() => {
  holder.mockReset();
  zoneHeld.mockReset();
});

function ctx(adapter: { parseConfig(input: unknown): unknown }, step: string | null = null) {
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
      id: RESOURCE,
      customerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      family: "domain",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: {},
    },
    config: adapter.parseConfig({ name: "example.com", tld: "com", contactSealed: SEALED }),
    account: { awsAccountId: "tc-dns", externalId: "tc-dns" },
    region: "us-east-1",
    access: {},
    env: "staging",
    clock: { now: () => new Date() },
    owned: async () => null,
  } as never;
}

describe("domain wiring (WP7-T4)", () => {
  it("is registered by family", () => {
    const registry = createAdapterRegistry([domainAdapter()]);
    expect(registry.get("domain")?.family).toBe("domain");
  });

  it("fails closed while the ports are not built: no AWS call, a fixed local error", async () => {
    const adapter = domainAdapter();
    holder.mockResolvedValue(RESOURCE);
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({
      code: "internal",
      retryable: false,
      reason: "not_configured",
    });
  });

  it("asks the database who holds the name: only the earliest live order goes on", async () => {
    const ports = {
      domains: () => ({ checkAvailability: async () => "available" }) as never,
      route53: () => ({}) as never,
      unsealContact: async () => ({}),
    };
    const adapter = domainAdapter(ports);
    holder.mockResolvedValue(RESOURCE);
    expect(await adapter.aws.create(ctx(adapter))).toMatchObject({
      kind: "next",
      step: "register",
    });
    expect(holder).toHaveBeenCalledWith({}, "example.com");
    holder.mockResolvedValue("99999999-8888-4777-8666-555555555555");
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({ code: "conflict" });
    holder.mockResolvedValue(null);
    await expect(adapter.aws.create(ctx(adapter))).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("a domain is never destroyed (R13)", () => {
  it("the guard refuses it in every subscription state", () => {
    for (const subscriptionStatus of ["active", "grace", "retained", "ended"]) {
      expect(
        decideDestructive("destroy", {
          subscriptionStatus,
          family: "domain",
          hasFinalSnapshot: true,
          isFinalBackup: false,
        } as never),
      ).toBe(false);
    }
  });
});
