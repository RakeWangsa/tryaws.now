import { beforeAll, expect, it } from "vitest";
import { DbError } from "../errors";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { readPriceBook, readPriceBooks, entryInForce } from "../repositories/config/price-book";
import { auditRowsOf } from "../testing/repos";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPA-P1: the price book (margin and commission of a family) and the base cost of the disk anchor.
const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const percent = (value: string) => ({ kind: "percent" as const, value });
const fixed = (value: string) => ({ kind: "fixed" as const, value });

let actor: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "test",
  };
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, role: DatabaseRole = "admin_rw") =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role });
const stored = async (family: string) =>
  (await t.pool.query("select value from settings where key = $1", [`price_book.${family}`])).rows;
const input = (over: Record<string, unknown> = {}) => ({
  market: "BD",
  family: "linux_instance",
  margin: percent("0.15"),
  commission: null,
  effectiveFrom: T0,
  at: T0,
  ...over,
});

it("the first save is a settings row with one entry, and one audit row with actor, reason, IP and target", async () => {
  const saved = await as((r) => r.priceBook.save(input({ commission: percent("0.2") }), "launch"));
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.replayed).toBe(false);
  expect(saved.value.family).toBe("linux_instance");
  expect(saved.value.entry.margin).toEqual(percent("0.15"));
  const rows = await stored("linux_instance");
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toEqual({
    v: 1,
    entries: [
      {
        from: T0.toISOString(),
        margin: percent("0.15"),
        commission: percent("0.2"),
        by: actor.adminId,
      },
    ],
  });
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "price_book.save",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_type: "admin",
    target_type: "price_book",
    target_id: "BD/linux_instance@2026-11-11T06:00:00.000Z",
    ip: "203.0.113.9",
    user_agent: "test",
  });
  expect(audits[0]?.metadata.reason).toBe("launch");
  expect(audits[0]?.metadata.before).toBeNull();
});

it("the same request again is a replay and changes nothing; the same start with other terms is a conflict", async () => {
  const again = await as((r) =>
    r.priceBook.save(input({ commission: percent("0.2") }), "launch again"),
  );
  expect(again).toMatchObject({ ok: true, replayed: true });
  const conflict = await as((r) => r.priceBook.save(input({ margin: percent("0.30") }), "other"));
  expect(conflict).toEqual({ ok: false, error: "conflict" });
  expect((await stored("linux_instance"))[0].value.entries).toHaveLength(1);
});

it("a later start appends an entry; the entry in force changes only when it starts", async () => {
  const later = await as((r) =>
    r.priceBook.save(
      input({ margin: fixed("500"), effectiveFrom: days(10), at: T0 }),
      "new price from the 10th",
    ),
  );
  expect(later).toMatchObject({ ok: true, replayed: false });
  const read = await as((r) => r.priceBook.read("BD"));
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const row = read.value.rows.find((x) => x.family === "linux_instance");
  expect(row?.entries).toHaveLength(2);
  expect(entryInForce(row?.entries ?? [], days(9))?.margin).toEqual(percent("0.15"));
  expect(entryInForce(row?.entries ?? [], days(10))?.margin).toEqual(fixed("500"));
  expect(entryInForce(row?.entries ?? [], new Date(T0.getTime() - 1))).toBeNull();
  // the audit row records the entry in force before the change
  const audits = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "price_book.save",
  );
  expect(audits.at(-1)?.metadata.before).toMatchObject({ margin: percent("0.15") });
});

it("saving the terms in force reports a scheduled change and does not withdraw it", async () => {
  const same = await as((r) =>
    r.priceBook.save(input({ commission: percent("0.2") }), "re-save the current terms"),
  );
  expect(same).toMatchObject({
    ok: true,
    replayed: true,
    value: { laterChangePending: days(10) },
  });
  expect((await stored("linux_instance"))[0].value.entries).toHaveLength(2);
});

it("refuses what is not a valid book entry, writing nothing", async () => {
  const before = (await t.pool.query("select count(*)::int as n from audit_log")).rows[0].n;
  for (const bad of [
    { market: "bd" },
    { family: "Linux Instance" },
    { family: "not_a_family" },
    { margin: percent("5.0001") },
    { margin: percent("0.12345") },
    { margin: fixed("1.5") },
    { margin: { kind: "fixed", value: 5 } },
    { margin: { kind: "other", value: "5" } },
    { commission: percent("1.01") },
    { effectiveFrom: new Date(T0.getTime() - 1) },
    { effectiveFrom: days(91) },
    { effectiveFrom: new Date("nope") },
  ]) {
    const refused = await as((r) => r.priceBook.save(input(bad) as never, "reason"));
    expect(refused).toEqual({ ok: false, error: "validation" });
  }
  const noReason = await as((r) => r.priceBook.save(input({ family: "disk" }), "   "));
  expect(noReason).toEqual({ ok: false, error: "validation" });
  expect((await t.pool.query("select count(*)::int as n from audit_log")).rows[0].n).toBe(before);
  expect(await stored("disk")).toEqual([]);
});

it("a row in settings that is not a book is never read as one: readPriceBook says invalid, a save replaces it", async () => {
  await t.pool.query(
    `insert into settings (id, key, market, scope, value)
     values (gen_random_uuid(), 'price_book.backup', 'BD', 'market', '{"v":1,"entries":[{"from":"x"}]}'::jsonb)`,
  );
  const read = await runTransaction(t.db, (tx) => readPriceBook(tx, "BD", "backup"), {
    role: "web_rw",
  });
  expect(read).toEqual({ state: "invalid" });
  const all = await runTransaction(t.db, (tx) => readPriceBooks(tx, "BD"), { role: "worker_rw" });
  expect(all.invalid).toEqual(["backup"]);
  const fixedUp = await as((r) =>
    r.priceBook.save(input({ family: "backup", margin: percent("0.1") }), "repair"),
  );
  expect(fixedUp).toMatchObject({ ok: true, replayed: false });
  const after = await runTransaction(t.db, (tx) => readPriceBook(tx, "BD", "backup"), {
    role: "web_rw",
  });
  expect(after.state).toBe("ok");
});

it("web_rw and worker_rw read the book and cannot write it", async () => {
  for (const role of ["web_rw", "worker_rw"] as const) {
    const read = await runTransaction(t.db, (tx) => readPriceBook(tx, "BD", "linux_instance"), {
      role,
    });
    expect(read.state).toBe("ok");
  }
  const error: unknown = await runTransaction(
    t.db,
    (tx) =>
      tx.execute(
        "update settings set value = '{}'::jsonb where key = 'price_book.linux_instance'" as never,
      ),
    { role: "web_rw" },
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
});

// --- the base cost of the disk anchor

const diskRow = async (region: string) =>
  (
    await t.pool.query(
      "select id, aws_price_usd::text as price from catalog_products where family = 'disk' and region = $1",
      [region],
    )
  ).rows[0] as { id: string; price: string };

it("the seeded disk anchor (USD 0.1000 a GB) can be changed by finance with a reason, and the change is audited", async () => {
  const row = await diskRow("ap-southeast-1");
  expect(row.price).toBe("0.1000");
  const set = await as((r) =>
    r.priceBook.setBaseCost({ catalogProductId: row.id, awsPriceUsd: "0.1250" }, "AWS price page"),
  );
  expect(set).toEqual({
    ok: true,
    replayed: false,
    value: {
      catalogProductId: row.id,
      family: "disk",
      region: "ap-southeast-1",
      awsPriceUsd: "0.125",
    },
  });
  expect((await diskRow("ap-southeast-1")).price).toBe("0.1250");
  // the other Region is untouched
  expect((await diskRow("ap-south-1")).price).toBe("0.1000");
  const audit = (await auditRowsOf(t.pool, actor.adminId)).filter(
    (a) => a.action === "catalog_price.set_base",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    target_type: "catalog_product",
    target_id: row.id,
    ip: "203.0.113.9",
  });
  expect(audit[0]?.metadata).toMatchObject({
    reason: "AWS price page",
    before: { awsPriceUsd: "0.1" },
    after: { awsPriceUsd: "0.125" },
  });
});

it("the same base cost again is a replay; a synced family, a missing row and a bad price are refused", async () => {
  const row = await diskRow("ap-southeast-1");
  const again = await as((r) =>
    r.priceBook.setBaseCost({ catalogProductId: row.id, awsPriceUsd: "0.125" }, "again"),
  );
  expect(again).toMatchObject({ ok: true, replayed: true });
  await t.pool.query(
    `insert into catalog_products (id, family, aws_id, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at)
     values (gen_random_uuid(), 'linux_instance', 'nano_3_0', 'ap-southeast-1', '{}'::jsonb, 5, 'month', 'linux_instance', true, now())`,
  );
  const synced = (
    await t.pool.query("select id from catalog_products where family = 'linux_instance' limit 1")
  ).rows[0].id as string;
  expect(
    await as((r) => r.priceBook.setBaseCost({ catalogProductId: synced, awsPriceUsd: "6" }, "no")),
  ).toEqual({ ok: false, error: "validation" });
  expect(
    await as((r) =>
      r.priceBook.setBaseCost(
        { catalogProductId: "0191e8a0-0000-7000-8000-000000000000", awsPriceUsd: "1" },
        "no",
      ),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  for (const bad of ["0", "0.0000", "-1", "1.23456", "1e1", "", "abc"]) {
    expect(
      await as((r) => r.priceBook.setBaseCost({ catalogProductId: row.id, awsPriceUsd: bad }, "x")),
    ).toEqual({ ok: false, error: "validation" });
  }
  expect((await diskRow("ap-southeast-1")).price).toBe("0.1250");
});

it("admin_rw can write only the base cost column of a catalog row; the AWS facts and the flag stay the sync's", async () => {
  for (const column of ["active", "family", "specs", "feature_flag", "region", "synced_at"]) {
    const value =
      column === "active"
        ? "false"
        : column === "specs"
          ? "'{}'::jsonb"
          : column === "synced_at"
            ? "now()"
            : "'x'";
    const error: unknown = await runTransaction(
      t.db,
      (tx) => tx.execute(`update catalog_products set ${column} = ${value} where false` as never),
      { role: "admin_rw" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, column).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("42501");
  }
});
