import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-Z13: the two database paths of domain-renewal.ts with the database replaced by spies: the hook the renewal
// charge calls (one insert of the operation, the message only for a new queued row) and the reversal of a failed
// registry renewal (what is read, locked, reversed and moved, in which order). The statements themselves are
// proved against PostgreSQL in domain-renewal.db.test.ts.

// vi.mock factories run before the module's own constants exist, so the spies are hoisted with them.
const {
  calls,
  track,
  insertOperation,
  operationPayload,
  lock,
  setPeriod,
  findCharge,
  lockWallet,
  reverseTransaction,
} = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    track:
      (name: string, fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        calls.push(name);
        return fn(...args);
      },
    insertOperation: vi.fn(),
    operationPayload: vi.fn(),
    lock: vi.fn(),
    setPeriod: vi.fn(),
    findCharge: vi.fn(),
    lockWallet: vi.fn(),
    reverseTransaction: vi.fn(),
  };
});

vi.mock("@tc/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/db")>()),
  insertOperation: track("insertOperation", insertOperation),
  findLedgerTransactionByKey: track("findCharge", findCharge),
  lifecycleRepo: () => ({
    operationPayload: track("operationPayload", operationPayload),
    lock: track("lock", lock),
    setPeriod: track("setPeriod", setPeriod),
  }),
}));
vi.mock("../ledger/balance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ledger/balance")>()),
  lockWallet: track("lockWallet", lockWallet),
}));
vi.mock("../ledger/reverse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ledger/reverse")>()),
  reverseTransaction: track("reverseTransaction", reverseTransaction),
}));

import type { LifecycleRow, Tx } from "@tc/db";
import {
  DomainRenewalError,
  domainRenewalKey,
  domainRenewalOperation,
  queueDomainRenewal,
  reverseFailedDomainRenewal,
} from "./domain-renewal";

const TX = { tx: true } as unknown as Tx;
const SUB = "0190a000-0000-7000-8000-000000000001";
const RES = "0190a000-0000-7000-8000-000000000002";
const CUS = "0190a000-0000-7000-8000-000000000003";
const CHARGE = "0190a000-0000-7000-8000-000000000004";
const REVERSAL = "0190a000-0000-7000-8000-000000000005";
const OP = "0190a000-0000-7000-8000-000000000006";
const DAY = 24 * 3_600_000;
const P = new Date("2027-11-11T06:00:00.000Z");
const NOW = new Date("2027-11-11T06:05:00.000Z");

function row(family = "domain", config: Record<string, unknown> = {}): LifecycleRow {
  return {
    id: SUB,
    resourceId: RES,
    customerId: CUS,
    market: "BD",
    termDays: 365,
    priceSnapshot: {},
    periodStart: P,
    periodEnd: new Date(P.getTime() + 365 * DAY),
    autoRenew: true,
    status: "active",
    resource: {
      family,
      state: "active",
      config: { expiresAt: "2027-11-12T08:00:00.000Z", ...config },
      deletedAt: null,
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const spy of [
    insertOperation,
    operationPayload,
    lock,
    setPeriod,
    findCharge,
    lockWallet,
    reverseTransaction,
  ]) {
    spy.mockReset();
  }
});

describe("queueDomainRenewal: the hook of a renewal charge", () => {
  it("queues the one renew_domain of the period and returns its first message", async () => {
    insertOperation.mockResolvedValue({
      operationId: OP,
      created: true,
      state: "queued",
      enqueueSeq: 0,
    });
    expect(await queueDomainRenewal(TX, row(), P, NOW)).toEqual({
      operationId: OP,
      resourceId: RES,
      enqueueSeq: 0,
    });
    expect(insertOperation).toHaveBeenCalledTimes(1);
    expect(insertOperation).toHaveBeenCalledWith(TX, domainRenewalOperation(row(), P), NOW);
    expect(insertOperation.mock.calls[0]?.[1]).toMatchObject({
      kind: "renew_domain",
      idempotencyKey: domainRenewalKey(SUB, P),
    });
  });

  it("a replay of the period finds the stored row: nothing new is sent (R7)", async () => {
    insertOperation.mockResolvedValue({
      operationId: OP,
      created: false,
      state: "queued",
      enqueueSeq: 3,
    });
    expect(await queueDomainRenewal(TX, row(), P, NOW)).toBeNull();
    insertOperation.mockResolvedValue({
      operationId: OP,
      created: true,
      state: "needs_approval",
      enqueueSeq: 0,
    });
    expect(await queueDomainRenewal(TX, row(), P, NOW)).toBeNull();
  });

  it("does nothing for a family without a registry", async () => {
    expect(await queueDomainRenewal(TX, row("linux_instance"), P, NOW)).toBeNull();
    expect(insertOperation).not.toHaveBeenCalled();
  });

  it("throws for a domain whose expiry is not known, before anything is written (R16)", async () => {
    await expect(
      queueDomainRenewal(TX, row("domain", { expiresAt: null }), P, NOW),
    ).rejects.toBeInstanceOf(DomainRenewalError);
    expect(insertOperation).not.toHaveBeenCalled();
  });

  it("lets an error of the insert reach the caller, whose transaction rolls the charge back", async () => {
    insertOperation.mockRejectedValue(new Error("db"));
    await expect(queueDomainRenewal(TX, row(), P, NOW)).rejects.toThrow("db");
  });
});

describe("reverseFailedDomainRenewal: the failed hook of a registry renewal", () => {
  const event = { operationId: OP, resourceId: RES, customerId: CUS, code: "conflict" };
  const payload = domainRenewalOperation(row(), P)?.payload;
  const logs: unknown[] = [];
  const deps = { log: (e: unknown) => logs.push(e) } as never;

  beforeEach(() => {
    logs.length = 0;
    operationPayload.mockResolvedValue(payload);
    lock.mockResolvedValue(row());
    findCharge.mockResolvedValue({ id: CHARGE, kind: "renewal", referenceId: SUB });
    lockWallet.mockResolvedValue(0n);
    reverseTransaction.mockResolvedValue({ ok: true, value: { transactionId: REVERSAL } });
    setPeriod.mockResolvedValue(undefined);
  });

  it("reverses the charge of the period once and ends the subscription at the period that was paid", async () => {
    expect(await reverseFailedDomainRenewal(TX, deps, event)).toEqual({
      reversalId: REVERSAL,
      ended: true,
    });
    expect(operationPayload).toHaveBeenCalledWith(RES, OP);
    expect(lock).toHaveBeenCalledWith(SUB);
    expect(findCharge).toHaveBeenCalledWith(TX, `renew:${SUB}:${P.toISOString()}`);
    expect(lockWallet).toHaveBeenCalledWith(TX, CUS);
    expect(reverseTransaction).toHaveBeenCalledTimes(1);
    expect(reverseTransaction).toHaveBeenCalledWith(TX, {
      transactionId: CHARGE,
      actor: { type: "system" },
      memo: "automatic reversal of a failed domain renewal",
    });
    expect(setPeriod).toHaveBeenCalledWith(SUB, {
      status: "ended",
      periodStart: new Date(P.getTime() - 365 * DAY),
      periodEnd: P,
    });
    // The lock order of the lifecycle and of renewNow: the subscription row, then the wallet.
    expect(calls).toEqual([
      "operationPayload",
      "lock",
      "findCharge",
      "lockWallet",
      "reverseTransaction",
      "setPeriod",
    ]);
    // Ids and a fixed word only (R14).
    expect(logs).toEqual([
      {
        event: "domain_renewal_reversed",
        operationId: OP,
        resourceId: RES,
        subscriptionId: SUB,
        reversalId: REVERSAL,
        ended: true,
      },
    ]);
  });

  it("a repeat after the move back is a replay of the keyed reversal and moves nothing", async () => {
    lock.mockResolvedValue({
      ...row(),
      status: "ended",
      periodStart: new Date(P.getTime() - 365 * DAY),
      periodEnd: P,
    });
    expect(await reverseFailedDomainRenewal(TX, deps, event)).toEqual({
      reversalId: REVERSAL,
      ended: false,
    });
    expect(reverseTransaction).toHaveBeenCalledTimes(1);
    expect(setPeriod).not.toHaveBeenCalled();
  });

  it("refuses what does not fit before any money moves: the failed move rolls back (R16)", async () => {
    const cases: (() => void)[] = [
      () => operationPayload.mockResolvedValue({ subscriptionId: SUB }),
      () => operationPayload.mockResolvedValue(null),
      () => lock.mockResolvedValue(null),
      () => lock.mockResolvedValue({ ...row(), customerId: CHARGE }),
      () => findCharge.mockResolvedValue(null),
      () =>
        lock.mockResolvedValue({
          ...row(),
          periodStart: new Date(P.getTime() + 365 * DAY),
          periodEnd: new Date(P.getTime() + 730 * DAY),
        }),
    ];
    for (const arrange of cases) {
      operationPayload.mockResolvedValue(payload);
      lock.mockResolvedValue(row());
      findCharge.mockResolvedValue({ id: CHARGE, kind: "renewal", referenceId: SUB });
      arrange();
      await expect(reverseFailedDomainRenewal(TX, deps, event)).rejects.toBeInstanceOf(
        DomainRenewalError,
      );
    }
    expect(lockWallet).not.toHaveBeenCalled();
    expect(reverseTransaction).not.toHaveBeenCalled();
    expect(setPeriod).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("a reversal the ledger refuses throws, and the subscription is not touched", async () => {
    reverseTransaction.mockResolvedValue({ ok: false, error: "conflict" });
    await expect(reverseFailedDomainRenewal(TX, deps, event)).rejects.toBeInstanceOf(
      DomainRenewalError,
    );
    expect(setPeriod).not.toHaveBeenCalled();
  });
});
