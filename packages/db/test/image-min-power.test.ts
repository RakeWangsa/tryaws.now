import { beforeEach, expect, it } from "vitest";
import type { Tx } from "../client";
import { adminRepos, type AdminActor } from "../repositories/admin/index";
import { readImageSwitches } from "../repositories/blueprints";
import { parseImageSwitches } from "../repositories/config/image-allowlist";
import { applyCatalogScope, type CatalogRowWrite } from "../repositories/system/catalog-sync";
import { auditRowsOf } from "../testing/repos";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G10. The minimum plan power of an image: AWS reports `minPower` on a blueprint (the sync stores it
// with the catalog row), and an admin may set the image's own minimum in the allow-list setting. The
// override survives a switch on or off, is audited, and a bad value is refused.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
beforeEach(async () => {
  await t.pool.query("delete from settings where key = 'image_allowlist'");
});
const AT = new Date("2026-11-11T06:00:00Z");
const row = (id: string, minPower: number | null): CatalogRowWrite => ({
  family: "blueprint",
  awsId: id,
  platform: "linux",
  region: "ap-southeast-1",
  specs: { name: id, kind: "app", group: null, version: null, loginUser: "bitnami", minPower },
  awsPriceUsd: "0",
  billingUnit: "none",
  featureFlag: "linux_instance",
  active: true,
});
const admin = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(a: AdminActor, fn: (r: ReturnType<typeof adminRepos>) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const stored = async () =>
  (await t.pool.query("select value from settings where key = 'image_allowlist'")).rows;

it("the sync keeps minPower in the specs of the image row", async () => {
  await ensureMarket(t.pool);
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: [row("g10_wp", 1000)], deactivate: [], at: AT }),
  );
  const found = await t.pool.query("select specs from catalog_products where aws_id = 'g10_wp'");
  expect(found.rows[0].specs.minPower).toBe(1000);
});

it("parses the optional minPower map and refuses a bad one (R16)", () => {
  const base = { v: 1, on: [], off: [] };
  expect(parseImageSwitches({ ...base, minPower: { wordpress: 1000 } })).toEqual({
    on: [],
    off: [],
    minPower: { wordpress: 1000 },
  });
  expect(parseImageSwitches({ ...base, minPower: {} })).toEqual({ on: [], off: [] });
  for (const bad of [
    { wordpress: -1 },
    { wordpress: 1.5 },
    { wordpress: "1000" },
    { wordpress: 100001 },
    { "Bad Id": 500 },
    [],
    "x",
  ]) {
    expect(parseImageSwitches({ ...base, minPower: bad }), JSON.stringify(bad)).toBeNull();
  }
});

it("an admin sets the minimum of an image with a reason; it is stored, read and audited", async () => {
  await ensureMarket(t.pool);
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: [row("g10_wp", 1000)], deactivate: [], at: AT }),
  );
  const a = await admin();
  const saved = await asAdmin(a, (r) =>
    r.blueprints.setMinPower({ market: "BD", blueprintId: "g10_wp", minPower: 2000 }, "needs 2 GB"),
  );
  expect(saved).toMatchObject({ ok: true, replayed: false });
  expect(await as("web_rw", (tx) => readImageSwitches(tx, "BD"))).toEqual({
    state: "ok",
    switches: { on: [], off: [], minPower: { g10_wp: 2000 } },
  });
  const audits = (await auditRowsOf(t.pool, a.adminId)).filter(
    (x) => x.action === "image_allowlist.min_power",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ target_type: "image_allowlist", target_id: "BD/g10_wp" });
  expect(audits[0]?.metadata.before).toEqual({ minPower: null });
  expect(audits[0]?.metadata.after).toEqual({ minPower: 2000 });
  // the same again is a replay; null removes the override
  expect(
    await asAdmin(a, (r) =>
      r.blueprints.setMinPower({ market: "BD", blueprintId: "g10_wp", minPower: 2000 }, "again"),
    ),
  ).toMatchObject({ ok: true, replayed: true });
  expect(
    await asAdmin(a, (r) =>
      r.blueprints.setMinPower({ market: "BD", blueprintId: "g10_wp", minPower: null }, "back"),
    ),
  ).toMatchObject({ ok: true, replayed: false });
  expect((await stored())[0].value.minPower).toBeUndefined();
});

it("switching an image on or off keeps the minimum of every image", async () => {
  await ensureMarket(t.pool);
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: [row("g10_wp", 1000)], deactivate: [], at: AT }),
  );
  const a = await admin();
  await asAdmin(a, (r) =>
    r.blueprints.setMinPower({ market: "BD", blueprintId: "g10_wp", minPower: 500 }, "r"),
  );
  await asAdmin(a, (r) =>
    r.blueprints.setEnabled({ market: "BD", blueprintId: "g10_wp", enabled: true }, "on"),
  );
  expect((await stored())[0].value).toEqual({
    v: 1,
    on: ["g10_wp"],
    off: [],
    minPower: { g10_wp: 500 },
  });
});

it("refuses an image the sync never listed, a value out of range, and a role that is not ops or superadmin", async () => {
  await ensureMarket(t.pool);
  await as("worker_rw", (tx) =>
    applyCatalogScope(tx, { rows: [row("g10_wp", null)], deactivate: [], at: AT }),
  );
  const a = await admin();
  const set = (over: Record<string, unknown>, actor = a) =>
    asAdmin(actor, (r) =>
      r.blueprints.setMinPower(
        { market: "BD", blueprintId: "g10_wp", minPower: 500, ...over } as never,
        "r",
      ),
    );
  expect(await set({ blueprintId: "never_listed" })).toEqual({ ok: false, error: "not_found" });
  for (const bad of [-1, 1.5, 100001, "500", Number.NaN]) {
    expect(await set({ minPower: bad }), String(bad)).toEqual({ ok: false, error: "validation" });
  }
  expect(await set({ market: "bd" })).toEqual({ ok: false, error: "validation" });
  expect(await set({}, await admin("finance"))).toEqual({ ok: false, error: "forbidden" });
  expect(await stored()).toHaveLength(0);
});
