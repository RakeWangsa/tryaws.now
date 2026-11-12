import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
const apply = vi.fn();
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  domainNameHolder: vi.fn(),
  hostedZoneHeldByOther: vi.fn(),
  readDomainSyncView: (...args: unknown[]) => read(...args),
  applyDomainFacts: (...args: unknown[]) => apply(...args),
}));

import { domainHooks } from "./domain";

// WPU-B2: the hook keeps the `domains` row in step with the operations of the domain. The database calls
// are mocked here (the row writes are proved in packages/db/test/domain-sync.test.ts); this proves the
// choice: which event moves which status, and that nothing is written when the machine has no such move.

const RESOURCE = "11111111-2222-4333-8444-555555555555";
const TX = { tx: true } as never;
const EVENT = (kind: string) => ({
  operationId: "op",
  resourceId: RESOURCE,
  customerId: "c",
  kind: kind as never,
});

beforeEach(() => {
  read.mockReset();
  apply.mockReset();
});

describe("domainHooks", () => {
  it("a create that succeeded moves pending to awaiting_verification with the adopted facts", async () => {
    read.mockResolvedValue({
      status: "pending",
      config: {
        domainStatus: "awaiting_verification",
        expiresAt: "2031-01-01T00:00:00.000Z",
        hostedZoneId: "Z0123456789",
      },
    });
    await domainHooks().succeeded?.(TX, EVENT("create"));
    expect(apply).toHaveBeenCalledWith(TX, RESOURCE, {
      from: "pending",
      to: "awaiting_verification",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
      hostedZoneId: "Z0123456789",
    });
  });

  it("a create that failed gives the name back (status failed)", async () => {
    read.mockResolvedValue({ status: "pending", config: {} });
    await domainHooks().failed?.(TX, { ...EVENT("create"), code: "conflict" });
    expect(apply).toHaveBeenCalledWith(TX, RESOURCE, { from: "pending", to: "failed" });
  });

  it("a renewal saves the new expiry", async () => {
    read.mockResolvedValue({
      status: "registered",
      config: { expiresAt: "2032-01-01T00:00:00.000Z" },
    });
    await domainHooks().succeeded?.(TX, EVENT("renew_domain"));
    expect(apply).toHaveBeenCalledWith(TX, RESOURCE, {
      from: "registered",
      to: "registered",
      expiresAt: new Date("2032-01-01T00:00:00.000Z"),
    });
  });

  it("writes nothing for a resource that is no domain, for a kind it does not know, or for a move the machine refuses", async () => {
    read.mockResolvedValueOnce(null);
    await domainHooks().succeeded?.(TX, EVENT("create"));
    read.mockResolvedValueOnce({ status: "pending", config: {} });
    await domainHooks().succeeded?.(TX, EVENT("reboot"));
    read.mockResolvedValueOnce({ status: "registered", config: {} });
    await domainHooks().failed?.(TX, { ...EVENT("create"), code: "x" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("lets a database error reach the caller, which rolls the state change back (R16)", async () => {
    read.mockResolvedValue({ status: "pending", config: {} });
    apply.mockRejectedValue(new Error("db"));
    await expect(domainHooks().failed?.(TX, { ...EVENT("create"), code: "x" })).rejects.toThrow(
      "db",
    );
  });
});
