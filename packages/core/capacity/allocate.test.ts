import type { QuotaCode } from "@tc/db";
import { describe, expect, it } from "vitest";
import { allocate, capacityWarning, freeUnits, resolveNeeds } from "./allocate";
import type { CapacityCell, PoolCandidate } from "./types";

const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";
const REGION = "ap-southeast-1";
const cell = (quotaCode: QuotaCode, limit: number, used: number, reserve = 0): CapacityCell => ({
  rowId: "",
  quotaCode,
  region: REGION,
  limit,
  used,
  reserve,
});
const account = (poolAccountId: string, ...cells: CapacityCell[]): PoolCandidate => ({
  poolAccountId,
  cells: cells.map((c) => ({ ...c, rowId: `${poolAccountId}:${c.quotaCode}` })),
});
const need = (quotaCode: QuotaCode, amount: number) => ({ quotaCode, region: REGION, amount });
const INSTANCE = [need("instance_vcpu", 2), need("static_ip", 1)];

describe("resolveNeeds", () => {
  it("adds equal cells together and sorts them by quota code", () => {
    expect(
      resolveNeeds(
        [
          { quotaCode: "static_ip", amount: 1 },
          { quotaCode: "instance_vcpu", amount: 2 },
          { quotaCode: "static_ip", amount: 1 },
        ],
        REGION,
      ),
    ).toEqual({ ok: true, needs: [need("instance_vcpu", 2), need("static_ip", 2)] });
  });
  it("puts an account-wide code on the Region global and keeps a Region that a need names", () => {
    expect(
      resolveNeeds(
        [
          { quotaCode: "bucket", amount: 1, region: "us-east-1" },
          { quotaCode: "certificate_active", amount: 1, region: "us-east-1" },
        ],
        REGION,
      ),
    ).toEqual({
      ok: true,
      needs: [
        { quotaCode: "bucket", region: "global", amount: 1 },
        { quotaCode: "certificate_active", region: "us-east-1", amount: 1 },
      ],
    });
  });
  it.each([
    [[], REGION],
    [[{ quotaCode: "static_ip", amount: 0 }], REGION],
    [[{ quotaCode: "static_ip", amount: 1.5 }], REGION],
    [[{ quotaCode: "static_ip", amount: -1 }], REGION],
    [[{ quotaCode: "gpu", amount: 1 }], REGION],
    [[{ quotaCode: "static_ip", amount: 1, region: "Singapore" }], REGION],
    [[{ quotaCode: "static_ip", amount: 1 }], "global"],
  ])("refuses %j in %s", (needs, region) => {
    expect(resolveNeeds(needs as never, region)).toMatchObject({ ok: false });
  });
  it("refuses more than 20 distinct cells", () => {
    const codes = [
      "static_ip",
      "database",
      "load_balancer",
      "container_service",
      "certificate_active",
      "certificate_365d",
      "disk_gb",
      "instance_vcpu",
    ] as const;
    const wide = codes.flatMap((quotaCode) =>
      ["ap-southeast-1", "ap-south-1", "us-east-1"].map((region) => ({
        quotaCode,
        amount: 1,
        region,
      })),
    );
    expect(wide).toHaveLength(24);
    expect(resolveNeeds(wide, REGION)).toMatchObject({ ok: false });
    expect(resolveNeeds(wide.slice(0, 20), REGION)).toMatchObject({ ok: true });
  });
});

describe("freeUnits", () => {
  it("is limit minus reserve minus used, and never below zero", () => {
    expect(freeUnits({ limit: 20, reserve: 2, used: 15 })).toBe(3);
    expect(freeUnits({ limit: 20, reserve: 0, used: 25 })).toBe(0);
    expect(freeUnits({ limit: 1, reserve: 3, used: 0 })).toBe(0);
  });
});

describe("capacityWarning", () => {
  it("warns from 70 percent of the limit and never for a limit of 0", () => {
    expect(capacityWarning({ limit: 10, used: 6 })).toBe(false);
    expect(capacityWarning({ limit: 10, used: 7 })).toBe(true);
    expect(capacityWarning({ limit: 20, used: 14 })).toBe(true);
    expect(capacityWarning({ limit: 5, used: 7 })).toBe(true);
    expect(capacityWarning({ limit: 0, used: 0 })).toBe(false);
    expect(capacityWarning({ limit: 0, used: 3 })).toBe(false);
  });
});

describe("allocate", () => {
  it("takes the first pool account by id, whatever the order of the input", () => {
    const a = account(A, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0));
    const b = account(B, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0));
    for (const input of [
      [a, b],
      [b, a],
    ]) {
      expect(allocate(INSTANCE, input)).toMatchObject({
        ok: true,
        placement: { poolAccountId: A },
      });
    }
  });
  it("places the cells with the row id and the used value that were read", () => {
    expect(
      allocate(INSTANCE, [account(A, cell("instance_vcpu", 4, 1), cell("static_ip", 5, 3))]),
    ).toEqual({
      ok: true,
      placement: {
        poolAccountId: A,
        cells: [
          {
            quotaCode: "instance_vcpu",
            region: REGION,
            amount: 2,
            rowId: `${A}:instance_vcpu`,
            used: 1,
          },
          { quotaCode: "static_ip", region: REGION, amount: 1, rowId: `${A}:static_ip`, used: 3 },
        ],
      },
    });
  });
  it("skips a full account and takes the next one", () => {
    const r = allocate(INSTANCE, [
      account(A, cell("instance_vcpu", 4, 4), cell("static_ip", 5, 0)),
      account(B, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0)),
    ]);
    expect(r).toMatchObject({ ok: true, placement: { poolAccountId: B } });
  });
  it("is all or nothing: one full quota rules the account out", () => {
    expect(
      allocate(INSTANCE, [account(A, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 5))]),
    ).toEqual({ ok: false, reason: "full" });
  });
  it("answers full when no account has room now", () => {
    expect(
      allocate(INSTANCE, [
        account(A, cell("instance_vcpu", 4, 3), cell("static_ip", 5, 0)),
        account(B, cell("instance_vcpu", 4, 4), cell("static_ip", 5, 0)),
      ]),
    ).toEqual({ ok: false, reason: "full" });
  });
  it("answers too_large for a request that no single account could hold, even empty", () => {
    expect(
      allocate(
        [need("instance_vcpu", 8)],
        [account(A, cell("instance_vcpu", 4, 0)), account(B, cell("instance_vcpu", 4, 0))],
      ),
    ).toEqual({ ok: false, reason: "too_large" });
  });
  it("counts the reserve as units that are not sold", () => {
    const rows = [cell("instance_vcpu", 4, 2, 1), cell("static_ip", 5, 0)];
    expect(allocate([need("instance_vcpu", 2)], [account(A, ...rows)])).toEqual({
      ok: false,
      reason: "full",
    });
    expect(allocate([need("instance_vcpu", 1)], [account(A, ...rows)])).toMatchObject({ ok: true });
  });
  it("never reads a live count above the limit as room", () => {
    expect(allocate([need("static_ip", 1)], [account(A, cell("static_ip", 5, 7))])).toEqual({
      ok: false,
      reason: "full",
    });
  });
  it("answers not_configured when a quota has no row, when there is no account and when nothing is needed", () => {
    expect(allocate(INSTANCE, [account(A, cell("instance_vcpu", 4, 0))])).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(allocate(INSTANCE, [])).toEqual({ ok: false, reason: "not_configured" });
    expect(allocate([], [account(A, cell("instance_vcpu", 4, 0))])).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });
  it("answers full, not too_large, when nothing is sellable: a limit of 0, a reserve at or above the limit, a used count at the limit", () => {
    expect(allocate([need("static_ip", 1)], [account(A, cell("static_ip", 0, 0))])).toEqual({
      ok: false,
      reason: "full",
    });
    expect(allocate([need("static_ip", 1)], [account(A, cell("static_ip", 1, 0, 3))])).toEqual({
      ok: false,
      reason: "full",
    });
    expect(allocate([need("static_ip", 1)], [account(A, cell("static_ip", 4, 4))])).toEqual({
      ok: false,
      reason: "full",
    });
    expect(allocate([need("static_ip", 3)], [account(A, cell("static_ip", 2, 0))])).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
  it("lets a full account outrank a too small one in the answer", () => {
    expect(
      allocate(INSTANCE, [
        account(A, cell("instance_vcpu", 4, 4), cell("static_ip", 5, 0)),
        account(B, cell("instance_vcpu", 1, 0), cell("static_ip", 5, 0)),
      ]),
    ).toEqual({ ok: false, reason: "full" });
  });
  it("lists the placed cells in the order of the needs it was given", () => {
    const r = allocate(
      [need("static_ip", 1), need("instance_vcpu", 2)],
      [account(A, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0))],
    );
    expect(r).toMatchObject({ ok: true });
    if (r.ok)
      expect(r.placement.cells.map((c) => c.quotaCode)).toEqual(["static_ip", "instance_vcpu"]);
  });
  it("does not change its input", () => {
    const input = [
      account(B, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0)),
      account(A, cell("instance_vcpu", 4, 0), cell("static_ip", 5, 0)),
    ];
    const before = JSON.stringify(input);
    allocate(INSTANCE, input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
