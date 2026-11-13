import { insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { draftHash } from "./ids";
import { runPurchase } from "./purchase";
import { verifyDraft } from "./token";

// WPU-G3. The image a customer chose for a new Linux server: it must be an image that AWS lists active in
// the Region of the plan and that the admin allow-list switches on. The draft checks it and the purchase
// checks it again, before any write (a switch-off between the two must not sell the image).
const t = useTempDatabase();
const SG = "ap-southeast-1";

beforeEach(async () => {
  await t.pool.query("delete from settings where key = 'image_allowlist'");
});

async function image(id: string, over: Record<string, unknown> = {}, region = SG): Promise<void> {
  await insertRow(t.pool, "catalog_products", {
    family: "blueprint",
    aws_id: id,
    platform: "linux",
    region,
    specs: JSON.stringify({
      name: id,
      kind: "os",
      group: null,
      version: null,
      loginUser: "ubuntu",
    }),
    aws_price_usd: "0",
    billing_unit: "none",
    feature_flag: "linux_instance",
    active: true,
    synced_at: "2026-11-11T00:00:00Z",
    ...over,
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

const refusal = { ok: false, error: "validation", fields: { blueprintId: "invalid" } } as const;

describe("createOrderDraft: the image must be offered", () => {
  it("accepts an image that is active in the Region and on by default", async () => {
    const kit = await makeKit(t);
    await image("ubuntu_24_04");
    const r = await createDraft(kit.deps, kit.session, kit.input({ blueprintId: "ubuntu_24_04" }));
    expect(r.ok).toBe(true);
  });

  it("refuses an image that is not in the catalog of the Region, and writes nothing", async () => {
    const kit = await makeKit(t);
    await image("debian_12", {}, "us-east-1"); // listed in another Region only
    const before = await snapshotRows(t);
    for (const id of ["debian_12", "no_such_image"]) {
      expect(await createDraft(kit.deps, kit.session, kit.input({ blueprintId: id }))).toEqual(
        refusal,
      );
    }
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("refuses an image that AWS no longer lists as active", async () => {
    const kit = await makeKit(t);
    await image("amazon_linux_2023", { active: false });
    expect(
      await createDraft(kit.deps, kit.session, kit.input({ blueprintId: "amazon_linux_2023" })),
    ).toEqual(refusal);
  });

  it("an image that is not on the default list is refused until an admin switches it on, and off again", async () => {
    const kit = await makeKit(t);
    await image("some_new_app", { specs: JSON.stringify({ name: "New", kind: "app" }) });
    const ask = () =>
      createDraft(kit.deps, kit.session, kit.input({ blueprintId: "some_new_app" }));
    expect(await ask()).toEqual(refusal);
    await setSwitches({ v: 1, on: ["some_new_app"], off: [] });
    expect((await ask()).ok).toBe(true);
    await setSwitches({ v: 1, on: [], off: ["some_new_app"] });
    expect(await ask()).toEqual(refusal);
  });

  it("an admin can switch a default image off", async () => {
    const kit = await makeKit(t);
    await image("debian_12");
    await setSwitches({ v: 1, on: [], off: ["debian_12"] });
    expect(
      await createDraft(kit.deps, kit.session, kit.input({ blueprintId: "debian_12" })),
    ).toEqual(refusal);
  });

  it("a stored allow-list that does not parse offers nothing (R16)", async () => {
    const kit = await makeKit(t);
    await image("ubuntu_22_04");
    await setSwitches({ v: 1, on: ["ubuntu_22_04"], off: ["ubuntu_22_04"] });
    expect(
      await createDraft(kit.deps, kit.session, kit.input({ blueprintId: "ubuntu_22_04" })),
    ).toEqual(refusal);
  });

  it("a malformed image id is refused by the configuration parser", async () => {
    const kit = await makeKit(t);
    expect(
      await createDraft(kit.deps, kit.session, kit.input({ blueprintId: "Ubuntu 24.04; x" })),
    ).toEqual({ ok: false, error: "validation", fields: { blueprintId: "invalid" } });
  });

  it("an order without an image (older order) is not checked here", async () => {
    const kit = await makeKit(t);
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
  });
});

describe("runPurchase: the image is checked again, before any write", () => {
  const purchase = (kit: Kit, token: string) => {
    const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
    if (!verdict.ok) throw new Error("the token does not verify");
    return kit.run((tx) =>
      runPurchase(tx, kit.deps, {
        claims: verdict.claims,
        tokenHash: draftHash(token),
        clientKey: "img-" + "a".repeat(16),
        customerId: kit.customerId,
      }),
    );
  };

  it("an image switched off between the draft and the purchase is refused and nothing changes", async () => {
    const kit = await makeKit(t);
    await image("node_ls_1_0", { specs: JSON.stringify({ name: "Node", kind: "app" }) });
    const { token } = await kit.draft({ blueprintId: "node_ls_1_0" });
    await setSwitches({ v: 1, on: [], off: ["node_ls_1_0"] });
    const before = await snapshotRows(t);
    expect(await purchase(kit, token)).toEqual(refusal);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("carries the chosen image into the resource configuration", async () => {
    const kit = await makeKit(t);
    await image("wordpress_ls_1_0", { specs: JSON.stringify({ name: "WP", kind: "app" }) });
    const { token } = await kit.draft({ blueprintId: "wordpress_ls_1_0" });
    const placed = await purchase(kit, token);
    expect(placed.ok).toBe(true);
    const row = await t.pool.query(
      "select config->>'blueprintId' as b from resources where customer_id = $1 and family = 'linux_instance'",
      [kit.customerId],
    );
    expect(row.rows.map((r) => r.b)).toContain("wordpress_ls_1_0");
  });
});
