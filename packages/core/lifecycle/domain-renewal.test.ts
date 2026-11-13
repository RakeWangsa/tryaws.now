import { APPROVAL_UNTIL, operationInsertValues } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  DomainRenewalError,
  decideDomainRenewalReversal,
  domainRenewalKey,
  domainRenewalOperation,
  readDomainRenewalPayload,
  type ReversalFacts,
} from "./domain-renewal";

// WPU-Z13: the pure rules of the registry renewal that a domain's renewal charge pays for (the hook of the
// lifecycle) and of the reversal when the registry refuses it. The database paths are proved in
// domain-renewal.db.test.ts and in the provisioner.

const SUB = "0190a000-0000-7000-8000-000000000001";
const RES = "0190a000-0000-7000-8000-000000000002";
const CUS = "0190a000-0000-7000-8000-000000000003";
const CHARGE = "0190a000-0000-7000-8000-000000000004";
const DAY = 24 * 3_600_000;
const START = new Date("2027-11-11T06:00:00.000Z");
/** The USD price the renewal charged (awsPriceUsd of its price snapshot). */
const USD = "13.0000";

const row = (family: string, config: Record<string, unknown>) => ({
  id: SUB,
  resourceId: RES,
  resource: { family, state: "active", config, deletedAt: null },
});
const domain = (config: Record<string, unknown> = { expiresAt: "2027-11-12T08:00:00.000Z" }) =>
  row("domain", config);

describe("the key of a registry renewal", () => {
  it("is the lifecycle's key form: one per subscription and period start (R7)", () => {
    expect(domainRenewalKey(SUB, START)).toBe(
      `lifecycle:renew-domain:${SUB}:2027-11-11T06:00:00.000Z`,
    );
    // Another period is another key; the same period is the same key, whoever charged it.
    expect(domainRenewalKey(SUB, new Date(START.getTime() + 365 * DAY))).not.toBe(
      domainRenewalKey(SUB, START),
    );
    expect(domainRenewalKey(SUB, new Date(START.getTime()))).toBe(domainRenewalKey(SUB, START));
  });

  it("WPU-Y2: a retry after a reversed renewal of the period has a key of its own (`:a<n>`)", () => {
    expect(domainRenewalKey(SUB, START, 0)).toBe(domainRenewalKey(SUB, START));
    expect(domainRenewalKey(SUB, START, 2)).toBe(
      `lifecycle:renew-domain:${SUB}:2027-11-11T06:00:00.000Z:a2`,
    );
  });
});

describe("the operation a domain's renewal charge queues", () => {
  it("renews one year at the registry with the expiry year the row holds", () => {
    expect(domainRenewalOperation(domain(), START, USD)).toEqual({
      resourceId: RES,
      kind: "renew_domain",
      payload: {
        subscriptionId: SUB,
        periodStart: "2027-11-11T06:00:00.000Z",
        currentExpiryYear: 2027,
        years: 1,
        // WPU-Z19: RenewDomain's Consent.MaxPrice: the registry may not charge more than the customer paid.
        maxPriceUsd: "13.0000",
      },
      idempotencyKey: domainRenewalKey(SUB, START),
    });
  });

  it("WPU-Y2: the retry of a reversed renewal names its attempt in the payload and the key", () => {
    expect(domainRenewalOperation(domain(), START, USD, 1)).toMatchObject({
      payload: { subscriptionId: SUB, periodStart: START.toISOString(), attempt: 1 },
      idempotencyKey: domainRenewalKey(SUB, START, 1),
    });
  });

  it("takes the UTC year of the stored expiry, the year Route 53 compares (not the Dhaka date)", () => {
    // 23:30 UTC on 31 December is already 1 January in Dhaka.
    const late = domainRenewalOperation(
      domain({ expiresAt: "2027-12-31T23:30:00.000Z" }),
      START,
      USD,
    );
    expect((late?.payload as { currentExpiryYear: number }).currentExpiryYear).toBe(2027);
  });

  it("WPU-Z19: refuses a USD price that is not plain positive decimal text (R4, R16)", () => {
    for (const bad of ["", "0", "0.0000", "-13", "1e3", "13.00001", " 13"]) {
      expect(() => domainRenewalOperation(domain(), START, bad), bad).toThrow(DomainRenewalError);
    }
  });

  it("is nothing for every other family: their renewal has no registry", () => {
    for (const family of ["linux_instance", "windows_instance", "dns_zone", "bucket", "cdn"]) {
      expect(domainRenewalOperation(row(family, {}), START, USD), family).toBeNull();
    }
  });

  it("refuses a domain whose registry expiry is not known: the charge must not stand (R16)", () => {
    for (const expiresAt of [
      undefined,
      null,
      "",
      "2027-11-12",
      "2027-11-12T08:00:00Z",
      "not a date",
      2027,
      { year: 2027 },
    ]) {
      const config = expiresAt === undefined ? {} : { expiresAt };
      expect(() => domainRenewalOperation(domain(config), START, USD), String(expiresAt)).toThrow(
        DomainRenewalError,
      );
    }
  });

  it("is a plain, non-destructive operation: queued at once, no admin approval before 2026-12-01 (R13)", () => {
    const input = domainRenewalOperation(domain(), START, USD);
    if (input === null) throw new Error("expected an operation");
    const values = operationInsertValues(
      input,
      new Date("2026-11-20T00:00:00.000Z"),
      new Date(APPROVAL_UNTIL),
    );
    expect(values).toMatchObject({
      kind: "renew_domain",
      state: "queued",
      needsApproval: false,
      idempotencyKey: domainRenewalKey(SUB, START),
    });
    expect(JSON.parse(values.payloadJson)).toEqual(input.payload);
  });
});

describe("the payload a failed renewal is read back from", () => {
  it("gives the subscription and the period of the charge", () => {
    const input = domainRenewalOperation(domain(), START, USD);
    expect(readDomainRenewalPayload(input?.payload)).toEqual({
      subscriptionId: SUB,
      periodStart: START,
      attempt: 0,
    });
    // WPU-Y2: the attempt of a retry, so the reversal finds the charge of that attempt
    expect(
      readDomainRenewalPayload(domainRenewalOperation(domain(), START, USD, 3)?.payload),
    ).toEqual({
      subscriptionId: SUB,
      periodStart: START,
      attempt: 3,
    });
  });

  it("is null for anything this module did not write", () => {
    for (const payload of [
      null,
      undefined,
      "x",
      [],
      {},
      { subscriptionId: SUB },
      { periodStart: START.toISOString() },
      { subscriptionId: "not-a-uuid", periodStart: START.toISOString() },
      { subscriptionId: SUB, periodStart: "2027-11-11" },
      { subscriptionId: SUB, periodStart: "2027-11-11T06:00:00Z" },
      { subscriptionId: SUB, periodStart: START },
      { subscriptionId: SUB, periodStart: START.toISOString(), attempt: 0 },
      { subscriptionId: SUB, periodStart: START.toISOString(), attempt: -1 },
      { subscriptionId: SUB, periodStart: START.toISOString(), attempt: 1.5 },
      { subscriptionId: SUB, periodStart: START.toISOString(), attempt: 100 },
      { subscriptionId: SUB, periodStart: START.toISOString(), attempt: "1" },
    ]) {
      expect(readDomainRenewalPayload(payload), JSON.stringify(payload)).toBeNull();
    }
  });
});

describe("the reversal decision", () => {
  const renewedEnd = new Date(START.getTime() + 365 * DAY);
  const facts = (over: Partial<ReversalFacts> = {}): ReversalFacts => ({
    resourceId: RES,
    customerId: CUS,
    payload: { subscriptionId: SUB, periodStart: START },
    subscription: {
      id: SUB,
      resourceId: RES,
      customerId: CUS,
      status: "active",
      periodStart: START,
      periodEnd: renewedEnd,
      termDays: 365,
    },
    charge: { id: CHARGE, kind: "renewal", referenceId: SUB },
    alreadyReversed: false,
    ...over,
  });

  it("reverses the charge of the period and moves the subscription back to the period that was paid", () => {
    expect(decideDomainRenewalReversal(facts())).toEqual({
      action: "reverse",
      chargeId: CHARGE,
      rollBack: { periodStart: new Date(START.getTime() - 365 * DAY), periodEnd: START },
    });
  });

  it("a repeat after the reversal is a replay of the keyed reversal and moves nothing, wherever the period is now", () => {
    const back = {
      ...facts().subscription!,
      status: "active" as const,
      periodStart: new Date(START.getTime() - 365 * DAY),
      periodEnd: START,
    };
    expect(
      decideDomainRenewalReversal(facts({ subscription: back, alreadyReversed: true })),
    ).toEqual({
      action: "reverse",
      chargeId: CHARGE,
      rollBack: null,
    });
    // WPU-Y2: the customer renewed the period again since (attempt 1): a late repeat must not move it back.
    expect(decideDomainRenewalReversal(facts({ alreadyReversed: true }))).toEqual({
      action: "reverse",
      chargeId: CHARGE,
      rollBack: null,
    });
  });

  it("refuses a payload it cannot read", () => {
    expect(decideDomainRenewalReversal(facts({ payload: null }))).toEqual({
      action: "refuse",
      reason: "payload",
    });
  });

  it("refuses a subscription that is missing, of another resource or of another customer (R8, R16)", () => {
    const sub = facts().subscription!;
    for (const subscription of [
      null,
      { ...sub, id: CHARGE },
      { ...sub, resourceId: CHARGE },
      { ...sub, customerId: CHARGE },
      { ...sub, termDays: 0 },
      { ...sub, termDays: 1.5 },
    ]) {
      expect(decideDomainRenewalReversal(facts({ subscription }))).toEqual({
        action: "refuse",
        reason: "subscription",
      });
    }
  });

  it("refuses when the charge of the period is missing or is not this subscription's renewal", () => {
    for (const charge of [
      null,
      { id: CHARGE, kind: "purchase", referenceId: SUB },
      { id: CHARGE, kind: "renewal", referenceId: RES },
    ]) {
      expect(decideDomainRenewalReversal(facts({ charge }))).toEqual({
        action: "refuse",
        reason: "charge",
      });
    }
  });

  it("refuses when the subscription is in another period: a person decides (R16)", () => {
    const sub = facts().subscription!;
    for (const subscription of [
      // A later period was charged since.
      { ...sub, periodStart: renewedEnd, periodEnd: new Date(renewedEnd.getTime() + 365 * DAY) },
      // Back at the paid period while the charge was never reversed: not the state this module leaves.
      {
        ...sub,
        periodStart: new Date(START.getTime() - 365 * DAY),
        periodEnd: START,
      },
    ]) {
      expect(decideDomainRenewalReversal(facts({ subscription }))).toEqual({
        action: "refuse",
        reason: "period",
      });
    }
  });
});
