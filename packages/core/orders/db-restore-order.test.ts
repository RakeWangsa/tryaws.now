// WPU-G9: a database order whose config names a manual snapshot, or a point in time, of the customer's
// own database. The rows are read through the tenant-scoped repository by resolveOrderProduct, which
// both the draft and the purchase call (R8). A refusal is a Result and nothing is written.
import { customerRepos } from "@tc/db";
import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, REGION, type Kit } from "../test/orders-kit";
import { resolveOrderProduct } from "./checks";

const t = useTempDatabase();
let kit: Kit;
const NOW = new Date("2026-11-12T12:00:00.000Z");

const plan = (diskGb: number) =>
  kit.newProduct({
    family: "database",
    platform: null,
    feature_flag: "database",
    specs: JSON.stringify({ diskGb }),
  });

async function database(customerId: string, over: Record<string, unknown> = {}) {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: "database",
    state: "active",
    pool_account_id: kit.poolAccountId,
    region: REGION,
    product_id: await plan(40),
    config: JSON.stringify({ displayName: "db-" + uniqueSuffix() }),
    ...over,
  });
}
async function snapshot(customerId: string, parent: string, over: Record<string, unknown> = {}) {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: "backup",
    state: "active",
    pool_account_id: kit.poolAccountId,
    region: REGION,
    parent_resource_id: parent,
    config: JSON.stringify({ displayName: "s-" + uniqueSuffix(), manual: true }),
    ...over,
  });
}
const resolve = (customerId: string, config: Record<string, unknown>) =>
  runTransaction(
    t.db,
    (tx) =>
      resolveOrderProduct(tx, customerRepos(tx, customerId), customerId, "database", config, NOW),
    { role: "web_rw" },
  );
const config = async (diskGb: number, extra: Record<string, unknown>) => ({
  productId: await plan(diskGb),
  region: REGION,
  displayName: "restored-" + uniqueSuffix(),
  ...extra,
});

beforeAll(async () => {
  kit = await makeKit(t, { riskTier: "trusted" });
});

describe("restore of a database snapshot", () => {
  it("accepts the customer's own active snapshot and a plan not smaller", async () => {
    const me = await kit.newBuyer();
    const db = await database(me.customerId);
    const snap = await snapshot(me.customerId, db);
    const r = await resolve(me.customerId, await config(80, { restoreFromBackupId: snap }));
    expect(r).toMatchObject({ ok: true, value: { restoreFromBackupId: snap, family: "database" } });
  });
  it("refuses a smaller plan and a snapshot that is not active", async () => {
    const me = await kit.newBuyer();
    const db = await database(me.customerId);
    const snap = await snapshot(me.customerId, db);
    const creating = await snapshot(me.customerId, db, { state: "creating" });
    expect(
      await resolve(me.customerId, await config(20, { restoreFromBackupId: snap })),
    ).toMatchObject({
      ok: false,
      fields: { productId: "too_small" },
    });
    expect(
      await resolve(me.customerId, await config(80, { restoreFromBackupId: creating })),
    ).toMatchObject({ ok: false, fields: { restoreFromBackupId: "invalid" } });
  });
  it("another customer's snapshot answers like a missing one (R8)", async () => {
    const mine = await kit.newBuyer();
    const theirs = await kit.newBuyer();
    const snap = await snapshot(theirs.customerId, await database(theirs.customerId));
    const stolen = await resolve(mine.customerId, await config(80, { restoreFromBackupId: snap }));
    const missing = await resolve(
      mine.customerId,
      await config(80, { restoreFromBackupId: crypto.randomUUID() }),
    );
    expect(stolen).toMatchObject({ ok: false, fields: { restoreFromBackupId: "invalid" } });
    expect(stolen).toEqual(missing);
  });
  it("a snapshot of a server is not a database snapshot", async () => {
    const me = await kit.newBuyer();
    const server = await database(me.customerId, { family: "linux_instance" });
    const snap = await snapshot(me.customerId, server);
    expect(
      await resolve(me.customerId, await config(80, { restoreFromBackupId: snap })),
    ).toMatchObject({
      ok: false,
      fields: { restoreFromBackupId: "invalid" },
    });
  });
});

describe("point-in-time restore", () => {
  it("accepts the customer's own database and an instant inside seven days", async () => {
    const me = await kit.newBuyer();
    const db = await database(me.customerId);
    const r = await resolve(
      me.customerId,
      await config(80, { restoreSourceId: db, restoreTime: "2026-11-10T09:00:00.000Z" }),
    );
    expect(r).toMatchObject({ ok: true, value: { restoreSourceId: db } });
  });
  it("refuses an instant outside the window", async () => {
    const me = await kit.newBuyer();
    const db = await database(me.customerId);
    for (const at of ["2026-10-01T00:00:00.000Z", "2026-11-12T11:59:00.000Z"]) {
      expect(
        await resolve(me.customerId, await config(80, { restoreSourceId: db, restoreTime: at })),
      ).toMatchObject({ ok: false, fields: { restoreTime: "out_of_range" } });
    }
  });
  it("another customer's database answers like a missing one (R8)", async () => {
    const mine = await kit.newBuyer();
    const theirs = await kit.newBuyer();
    const db = await database(theirs.customerId);
    const at = "2026-11-10T09:00:00.000Z";
    const stolen = await resolve(
      mine.customerId,
      await config(80, { restoreSourceId: db, restoreTime: at }),
    );
    const missing = await resolve(
      mine.customerId,
      await config(80, { restoreSourceId: crypto.randomUUID(), restoreTime: at }),
    );
    expect(stolen).toMatchObject({ ok: false, fields: { restoreSourceId: "invalid" } });
    expect(stolen).toEqual(missing);
  });
});
