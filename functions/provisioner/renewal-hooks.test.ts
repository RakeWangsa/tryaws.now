import { beforeEach, describe, expect, it, vi } from "vitest";

const { reverse } = vi.hoisted(() => ({ reverse: vi.fn() }));
vi.mock("@tc/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/core")>()),
  reverseFailedDomainRenewal: (...args: unknown[]) => reverse(...args),
}));

import { renewalHooks } from "./renewal-hooks";

// WPU-Z13: the failed hook of a domain renewal hands the failed operation to the reversal of @tc/core, in the
// transaction of the move to failed; every other kind is left alone. The reversal itself is proved in
// packages/core/lifecycle (domain-renewal.db.test.ts) and through runStep in domain-renewal.test.ts here.

const TX = { tx: true } as never;
const EVENT = (kind: string) => ({
  operationId: "0190a000-0000-7000-8000-000000000006",
  resourceId: "0190a000-0000-7000-8000-000000000002",
  customerId: "0190a000-0000-7000-8000-000000000003",
  kind: kind as never,
  code: "conflict",
});

beforeEach(() => {
  reverse.mockReset();
});

describe("renewalHooks", () => {
  it("a failed renew_domain reverses its charge, with the ids of the operation", async () => {
    reverse.mockResolvedValue({ reversalId: "r", ended: true });
    const log = () => undefined;
    await renewalHooks({ log }).failed?.(TX, EVENT("renew_domain"));
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(reverse).toHaveBeenCalledWith(
      TX,
      { log },
      {
        operationId: "0190a000-0000-7000-8000-000000000006",
        resourceId: "0190a000-0000-7000-8000-000000000002",
        customerId: "0190a000-0000-7000-8000-000000000003",
      },
    );
  });

  it("does nothing for any other kind: a create has its own reversal (order-hooks.ts)", async () => {
    for (const kind of ["create", "reboot", "set_name_servers", "resend_verification"]) {
      await renewalHooks({}).failed?.(TX, EVENT(kind));
    }
    expect(reverse).not.toHaveBeenCalled();
  });

  it("has only a failed hook: success and attention change no money", () => {
    const hooks = renewalHooks({});
    expect(Object.keys(hooks)).toEqual(["failed"]);
  });

  it("lets an error reach the caller, which rolls the move to failed back (R16)", async () => {
    reverse.mockRejectedValue(new Error("refused"));
    await expect(renewalHooks({}).failed?.(TX, EVENT("renew_domain"))).rejects.toThrow("refused");
  });
});
