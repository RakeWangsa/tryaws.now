import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, PLAN_TOTAL, REGION, snapshotRows } from "../test/orders-kit";
import { createDraft } from "./draft";
import { DEFAULT_TIER_LIMITS } from "./gates";
import { verifyDraft } from "./token";
import { DRAFT_TTL_SECONDS } from "./types";

const t = useTempDatabase();

describe("createDraft", () => {
  it("returns a token that verifies and carries the customer, the product, the snapshot and 30 minutes", async () => {
    const kit = await makeKit(t);
    const input = kit.input();
    const r = await createDraft(kit.deps, kit.session, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const verdict = verifyDraft(kit.secrets, r.value.token, kit.clock.now());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const { claims } = verdict;
    expect(claims.c).toBe(kit.customerId);
    expect(claims.fam).toBe("linux_instance");
    expect(claims.pid).toBe(kit.productId);
    expect(claims.region).toBe(REGION);
    expect(claims.cfg).toEqual({ ...input.config, keyPairId: null });
    expect(claims.exp - claims.iat).toBe(DRAFT_TTL_SECONDS);
    expect(claims.iat).toBe(Math.floor(kit.clock.now().getTime() / 1000));
    expect(r.value.expiresAt).toEqual(new Date(claims.exp * 1000));
    // the quote is the sum of the base and the steps and is the total of the snapshot (R4)
    const q = r.value.quote;
    expect(q.totalMinor).toBe(PLAN_TOTAL);
    expect(q.baseMinor + q.steps.reduce((sum, s) => sum + s.amountMinor, 0n)).toBe(q.totalMinor);
    expect(BigInt(claims.snap.totalMinor)).toBe(q.totalMinor);
  });

  it("writes nothing and takes no unit: ten tables are equal before and after", async () => {
    const kit = await makeKit(t);
    const before = await snapshotRows(t);
    const usedBefore = await kit.used();
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
    expect(await snapshotRows(t)).toEqual(before);
    expect(await kit.used()).toEqual(usedBefore);
  });

  it("does not check the balance: an empty wallet still gets a draft", async () => {
    const kit = await makeKit(t, { balanceMinor: 0n });
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
  });

  const refused = async (
    options: Parameters<typeof makeKit>[1],
    expected: object,
    bend?: (kit: Awaited<ReturnType<typeof makeKit>>) => Promise<void>,
  ) => {
    const kit = await makeKit(t, options);
    if (bend) await bend(kit);
    const before = await snapshotRows(t);
    expect(await createDraft(kit.deps, kit.session, kit.input())).toMatchObject(expected);
    expect(await snapshotRows(t)).toEqual(before);
  };

  it("refuses a customer whose KYC is none as kyc_required", () =>
    refused({ kycStatus: "none" }, { ok: false, error: "kyc_required" }));
  it("refuses a customer whose KYC is pending or rejected as kyc_required", async () => {
    await refused({ kycStatus: "pending" }, { ok: false, error: "kyc_required" });
    await refused({ kycStatus: "rejected" }, { ok: false, error: "kyc_required" });
  });
  it("refuses a suspended customer as forbidden", () =>
    refused({ status: "suspended" }, { ok: false, error: "forbidden" }));
  it("refuses with flag_off when the family flag is off", () =>
    refused({ flag: "off" }, { ok: false, error: "flag_off" }));
  it("refuses with flag_off when the family flag has no row", () =>
    refused({ flag: "missing" }, { ok: false, error: "flag_off" }));
  it("refuses an instance over the limit of a new customer as limit_reached", () =>
    refused({}, { ok: false, error: "limit_reached", fields: { limit: "instances" } }, (kit) =>
      seedLiveInstances(kit, DEFAULT_TIER_LIMITS.new.maxInstances),
    ));
  it("refuses with capacity_full and the waitlist offer when the pool is full", () =>
    refused(
      {},
      { ok: false, error: "capacity_full", data: { reason: "full", waitlist: "offered" } },
      async (kit) => {
        await kit.t.pool.query("update pool_capacity set used = quota_limit");
      },
    ));
  it("refuses with not_found when no exchange rate is in force", async () => {
    const kit = await makeKit(t);
    kit.clock.set(new Date("2020-01-01T00:00:00.000Z"));
    expect(await createDraft(kit.deps, kit.session, kit.input())).toMatchObject({
      ok: false,
      error: "not_found",
      fields: { fxRate: "not_in_force" },
    });
  });
  it("refuses an inactive product as validation", () =>
    refused({ productActive: false }, { ok: false, error: "validation" }));
  it("refuses an input with an extra key or a missing key as validation", async () => {
    const kit = await makeKit(t);
    for (const bad of [{ ...kit.input(), extra: 1 }, { family: "linux_instance" }, null, "x", []]) {
      expect(await createDraft(kit.deps, kit.session, bad)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
  });
  it("refuses a family it cannot sell as validation", async () => {
    const kit = await makeKit(t);
    expect(
      await createDraft(kit.deps, kit.session, { family: "dns_zone", config: {} }),
    ).toMatchObject({ ok: false, error: "validation", fields: { family: "unsupported" } });
  });

  it("decides on the row, not on the session: a session that says verified over a row that says none", async () => {
    const kit = await makeKit(t);
    await kit.setCustomer(kit.customerId, { kyc_status: "none" });
    expect(kit.session.kycStatus).toBe("verified");
    expect(await createDraft(kit.deps, kit.session, kit.input())).toMatchObject({
      ok: false,
      error: "kyc_required",
    });
  });

  it("refuses a customer who has no row as forbidden", async () => {
    const kit = await makeKit(t);
    const ghost = { ...kit.session, customerId: "0190bbbb-0000-7000-8000-00000000fffe" };
    expect(await createDraft(kit.deps, ghost, kit.input())).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("throws a TypeError for an empty or short secret before any query is sent", async () => {
    const kit = await makeKit(t);
    const run = () => {
      throw new Error("a query was attempted");
    };
    for (const secrets of [[], [new Uint8Array(31)]]) {
      const deps = { ...kit.deps, run: run as typeof kit.deps.run, secrets };
      await expect(createDraft(deps, kit.session, kit.input())).rejects.toBeInstanceOf(TypeError);
    }
  });
});

// Live instances of the customer, as the owner (resources are written by the purchase only).
async function seedLiveInstances(
  kit: Awaited<ReturnType<typeof makeKit>>,
  count: number,
): Promise<void> {
  await kit.t.pool.query(
    `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
     select gen_random_uuid(), $1, 'linux_instance', $2, $3, $4, '{}'::jsonb from generate_series(1, $5::int)`,
    [kit.customerId, kit.productId, kit.poolAccountId, REGION, count],
  );
}
