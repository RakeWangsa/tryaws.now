import { insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { draftHash } from "./ids";
import { runPurchase } from "./purchase";
import { verifyDraft } from "./token";

// WPU-G10. An app image needs a minimum bundle power (Lightsail enforces it). The draft and the purchase
// refuse a plan below it before any write; the minimum is what AWS reported for the blueprint, the admin's
// override if there is one, or a safe default for an app that has none (R16).
const t = useTempDatabase();
const SG = "ap-southeast-1";
const TOO_SMALL = {
  ok: false,
  error: "validation",
  fields: { productId: "plan_too_small" },
} as const;

beforeEach(async () => {
  await t.pool.query("delete from settings where key = 'image_allowlist'");
  await t.pool.query("delete from catalog_products where family = 'blueprint'");
});

async function image(id: string, specs: Record<string, unknown>): Promise<void> {
  await insertRow(t.pool, "catalog_products", {
    family: "blueprint",
    aws_id: id,
    platform: "linux",
    region: SG,
    specs: JSON.stringify({ name: id, group: null, version: null, loginUser: "bitnami", ...specs }),
    aws_price_usd: "0",
    billing_unit: "none",
    feature_flag: "linux_instance",
    active: true,
    synced_at: "2026-11-11T00:00:00Z",
  });
}
async function setSwitches(value: unknown): Promise<void> {
  await t.pool.query("delete from settings where key = 'image_allowlist' and market = 'BD'");
  await t.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), 'image_allowlist', 'BD', 'market', null, $1::jsonb)`,
    [JSON.stringify(value)],
  );
}
const plan = (kit: Kit, power: number | null) =>
  kit.newProduct({
    specs: JSON.stringify({ vcpus: 1, ramGb: "0.5", ...(power === null ? {} : { power }) }),
  });

describe("createOrderDraft: the plan must reach the minimum power of the image", () => {
  it("refuses a 512 MB plan for an app whose blueprint says minPower 1000, and writes nothing", async () => {
    const kit = await makeKit(t);
    await image("wordpress", { kind: "app", minPower: 1000 });
    const small = await plan(kit, 500);
    const before = await snapshotRows(t);
    expect(
      await createDraft(
        kit.deps,
        kit.session,
        kit.input({ blueprintId: "wordpress", productId: small }),
      ),
    ).toEqual(TOO_SMALL);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("accepts a plan at the minimum and one above it", async () => {
    const kit = await makeKit(t);
    await image("wordpress", { kind: "app", minPower: 1000 });
    for (const power of [1000, 2000]) {
      const ok = await plan(kit, power);
      expect(
        (
          await createDraft(
            kit.deps,
            kit.session,
            kit.input({ blueprintId: "wordpress", productId: ok }),
          )
        ).ok,
      ).toBe(true);
    }
  });

  it("an OS image with minPower 0 runs on the smallest plan", async () => {
    const kit = await makeKit(t);
    await image("ubuntu_24_04", { kind: "os", minPower: 0 });
    const small = await plan(kit, 500);
    expect(
      (
        await createDraft(
          kit.deps,
          kit.session,
          kit.input({ blueprintId: "ubuntu_24_04", productId: small }),
        )
      ).ok,
    ).toBe(true);
  });

  it("an app with no known minimum falls back to the 1 GB class; an OS image with none runs anywhere", async () => {
    const kit = await makeKit(t);
    await image("nodejs", { kind: "app" });
    await image("debian_12", { kind: "os" });
    const small = await plan(kit, 298);
    expect(
      await createDraft(
        kit.deps,
        kit.session,
        kit.input({ blueprintId: "nodejs", productId: small }),
      ),
    ).toEqual(TOO_SMALL);
    expect(
      (
        await createDraft(
          kit.deps,
          kit.session,
          kit.input({ blueprintId: "debian_12", productId: small }),
        )
      ).ok,
    ).toBe(true);
  });

  it("a plan whose power is unknown is refused for an image with a minimum (R16)", async () => {
    const kit = await makeKit(t);
    await image("wordpress", { kind: "app", minPower: 500 });
    const unknown = await plan(kit, null);
    expect(
      await createDraft(
        kit.deps,
        kit.session,
        kit.input({ blueprintId: "wordpress", productId: unknown }),
      ),
    ).toEqual(TOO_SMALL);
  });

  it("the admin override replaces what AWS reported, in both directions", async () => {
    const kit = await makeKit(t);
    await image("wordpress", { kind: "app", minPower: 1000 });
    const small = await plan(kit, 500);
    const ask = () =>
      createDraft(kit.deps, kit.session, kit.input({ blueprintId: "wordpress", productId: small }));
    expect(await ask()).toEqual(TOO_SMALL);
    await setSwitches({ v: 1, on: [], off: [], minPower: { wordpress: 500 } });
    expect((await ask()).ok).toBe(true);
    await setSwitches({ v: 1, on: [], off: [], minPower: { wordpress: 2000 } });
    expect(await ask()).toEqual(TOO_SMALL);
  });
});

describe("runPurchase: the minimum is checked again, before any write", () => {
  it("an override raised between the draft and the purchase refuses the purchase and changes nothing", async () => {
    const kit = await makeKit(t);
    await image("wordpress", { kind: "app", minPower: 500 });
    const small = await plan(kit, 500);
    const { token } = await kit.draft({ blueprintId: "wordpress", productId: small });
    await setSwitches({ v: 1, on: [], off: [], minPower: { wordpress: 2000 } });
    const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
    if (!verdict.ok) throw new Error("the token does not verify");
    const before = await snapshotRows(t);
    const result = await kit.run((tx) =>
      runPurchase(tx, kit.deps, {
        claims: verdict.claims,
        tokenHash: draftHash(token),
        clientKey: "pow-" + "a".repeat(16),
        customerId: kit.customerId,
      }),
    );
    expect(result).toEqual(TOO_SMALL);
    expect(await snapshotRows(t)).toEqual(before);
  });
});
