import { v7 as uuidv7 } from "uuid";
import { beforeEach, expect, it } from "vitest";
import type { Tx } from "../client";
import { adminRepos, type AdminActor } from "../repositories/admin/index";
import {
  listActiveImages,
  listImagesForAdmin,
  readImage,
  readImageAnyRegion,
  readImageSwitches,
} from "../repositories/blueprints";
import { parseImageSwitches } from "../repositories/config/image-allowlist";
import { applyCatalogScope, type CatalogRowWrite } from "../repositories/system/catalog-sync";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G3. The image rows (catalog_products, family `blueprint`) and the admin allow-list (settings,
// key image_allowlist). Needs the local PostgreSQL. The sync is worker_rw, the panel web_rw, the admin
// switch admin_rw.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });
beforeEach(async () => {
  await t.pool.query("delete from settings where key = 'image_allowlist'");
});
const AT = new Date("2026-11-11T06:00:00Z");
const SG = "ap-southeast-1";
const US = "us-east-1";

const image = (id: string, region = SG, over: Partial<CatalogRowWrite> = {}): CatalogRowWrite => ({
  family: "blueprint",
  awsId: id,
  platform: "linux",
  region,
  specs: { name: id, kind: "os", group: null, version: null, loginUser: "ubuntu" },
  awsPriceUsd: "0",
  billingUnit: "none",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});
const seed = (rows: CatalogRowWrite[]) =>
  as("worker_rw", (tx) => applyCatalogScope(tx, { rows, deactivate: [], at: AT }));
const admin = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(a: AdminActor, fn: (r: ReturnType<typeof adminRepos>) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const stored = async (market = "BD") =>
  (
    await t.pool.query(
      "select value, set_by from settings where key = 'image_allowlist' and market = $1",
      [market],
    )
  ).rows;

it("the sync writes the image rows with the grants it has; the panel reads the active ones of a Region", async () => {
  await seed([image("g3_a"), image("g3_b", SG, { active: false }), image("g3_a", US)]);
  const sg = await as("web_rw", (tx) => listActiveImages(tx, SG));
  expect(sg.map((r) => r.awsId)).toEqual(["g3_a"]);
  expect((await as("web_rw", (tx) => listActiveImages(tx, US))).map((r) => r.awsId)).toEqual([
    "g3_a",
  ]);
  expect((await as("web_rw", (tx) => readImage(tx, SG, "g3_b")))?.active).toBe(false);
  expect(await as("web_rw", (tx) => readImage(tx, US, "g3_b"))).toBeNull();
  expect(await as("web_rw", (tx) => readImage(tx, SG, "Not An Id"))).toBeNull();
  expect((await as("web_rw", (tx) => readImageAnyRegion(tx, "g3_a")))?.region).toBe(SG);
  await expect(as("web_rw", (tx) => listActiveImages(tx, "mars"))).rejects.toThrow(
    "listActiveImages: region is invalid",
  );
  const all = await as("admin_rw", (tx) => listImagesForAdmin(tx));
  expect(all.filter((r) => r.awsId.startsWith("g3_"))).toHaveLength(3);
});

it("the images are no plan: the instance families do not list them", async () => {
  await seed([image("g3_plan")]);
  const { rows } = await t.pool.query(
    "select count(*)::int as n from catalog_products where family = 'linux_instance' and aws_id = 'g3_plan'",
  );
  expect(rows[0].n).toBe(0);
});

it("setEnabled stores the switch, writes one audit row with actor, reason, IP and target, and replays the same value (R10, R7)", async () => {
  await ensureMarket(t.pool);
  await seed([image("g3_audit")]);
  const me = await admin();
  expect(await asAdmin(me, (r) => r.blueprints.list("BD"))).toMatchObject({
    ok: true,
    value: { switches: { state: "none" } },
  });
  const first = await asAdmin(me, (r) =>
    r.blueprints.setEnabled(
      { market: "BD", blueprintId: "g3_audit", enabled: true },
      "isolation test passed",
    ),
  );
  expect(first).toEqual({
    ok: true,
    value: { market: "BD", blueprintId: "g3_audit", enabled: true },
    replayed: false,
  });
  const row = (await stored())[0];
  expect(parseImageSwitches(row.value)).toEqual({ on: ["g3_audit"], off: [] });
  expect(row.set_by).toBe(me.adminId);

  const again = await asAdmin(me, (r) =>
    r.blueprints.setEnabled({ market: "BD", blueprintId: "g3_audit", enabled: true }, "again"),
  );
  expect(again).toMatchObject({ ok: true, replayed: true });

  // Off moves the id from one list to the other; the lists stay disjoint.
  await asAdmin(me, (r) =>
    r.blueprints.setEnabled({ market: "BD", blueprintId: "g3_audit", enabled: false }, "retired"),
  );
  expect(parseImageSwitches((await stored())[0].value)).toEqual({ on: [], off: ["g3_audit"] });

  const rows = (
    await t.pool.query(
      "select action, target_type, target_id, ip, metadata from audit_log where actor_id = $1 order by created_at",
      [me.adminId],
    )
  ).rows;
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    action: "image_allowlist.set",
    target_type: "image_allowlist",
    target_id: "BD/g3_audit",
    ip: "203.0.113.9",
  });
  expect(rows[0].metadata).toMatchObject({
    reason: "isolation test passed",
    before: { on: false, off: false },
    after: { on: true, off: false },
  });
  const read = await as("web_rw", (tx) => readImageSwitches(tx, "BD"));
  expect(read).toEqual({ state: "ok", switches: { on: [], off: ["g3_audit"] } });
});

it("an unknown image is not_found; a bad id, a bad market, a non-boolean and a blank reason are validation; nothing is written", async () => {
  await ensureMarket(t.pool);
  const me = await admin();
  const call = (input: unknown, reason = "r") =>
    asAdmin(me, (r) => r.blueprints.setEnabled(input as never, reason));
  expect(await call({ market: "BD", blueprintId: "g3_missing", enabled: true })).toEqual({
    ok: false,
    error: "not_found",
  });
  await seed([image("g3_valid")]);
  for (const bad of [
    { market: "BD", blueprintId: "Bad Id", enabled: true },
    { market: "bd", blueprintId: "g3_valid", enabled: true },
    { market: "BD", blueprintId: "g3_valid", enabled: "yes" },
  ]) {
    expect(await call(bad)).toEqual({ ok: false, error: "validation" });
  }
  expect(await call({ market: "BD", blueprintId: "g3_valid", enabled: true }, "  ")).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await stored()).toHaveLength(0);
  const n = (
    await t.pool.query("select count(*)::int as n from audit_log where actor_id = $1", [me.adminId])
  ).rows[0].n;
  expect(n).toBe(0);
});

it("a stored value that does not parse reads as invalid and is replaced by the next save", async () => {
  await ensureMarket(t.pool);
  await seed([image("g3_fix")]);
  await t.pool.query(
    "insert into settings (id, key, market, scope, scope_id, value) values ($1, 'image_allowlist', 'BD', 'market', null, $2::jsonb)",
    [uuidv7(), JSON.stringify({ v: 1, on: ["g3_fix"], off: ["g3_fix"] })],
  );
  expect(await as("worker_rw", (tx) => readImageSwitches(tx, "BD"))).toEqual({ state: "invalid" });
  const me = await admin();
  await asAdmin(me, (r) =>
    r.blueprints.setEnabled({ market: "BD", blueprintId: "g3_fix", enabled: true }, "repair"),
  );
  expect(await as("worker_rw", (tx) => readImageSwitches(tx, "BD"))).toEqual({
    state: "ok",
    switches: { on: ["g3_fix"], off: [] },
  });
});

it("setEnabled and list are refused to a role outside ops and superadmin, and to an actor that is no admin", async () => {
  await ensureMarket(t.pool);
  await seed([image("g3_gate")]);
  const finance = await admin("finance");
  expect(
    await asAdmin(finance, (r) =>
      r.blueprints.setEnabled({ market: "BD", blueprintId: "g3_gate", enabled: true }, "r"),
    ),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await asAdmin(finance, (r) => r.blueprints.list("BD"))).toEqual({
    ok: false,
    error: "forbidden",
  });
  const ghost: AdminActor = { adminId: uuidv7(), role: "ops", ip: "203.0.113.9" };
  expect(
    await asAdmin(ghost, (r) =>
      r.blueprints.setEnabled({ market: "BD", blueprintId: "g3_gate", enabled: true }, "r"),
    ),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await stored()).toHaveLength(0);
  const sa = await admin("superadmin");
  const listed = await asAdmin(sa, (r) => r.blueprints.list("BD"));
  expect(listed.ok && listed.value.images.some((i) => i.awsId === "g3_gate")).toBe(true);
});
