import { beforeEach, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin, newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const actor = async (): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, "ops"),
  role: "ops",
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const entry = (
  customerId: string | null,
  email: string | null,
  minute: number,
  over: Record<string, unknown> = {},
) =>
  insertRow(t.pool, "waitlist_entries", {
    customer_id: customerId,
    email,
    product_family: "linux_instance",
    region: REGION,
    reason: "capacity",
    created_at: new Date(Date.parse("2026-11-01T00:00:00Z") + minute * 60_000).toISOString(),
    ...over,
  });
const OK = {
  productFamily: "linux_instance",
  region: REGION,
  reason: "capacity" as const,
  count: 1,
};

beforeEach(async () => {
  await ensureMarket(t.pool);
  await t.pool.query("delete from waitlist_entries");
});

it("notifies the oldest entries first and lists the positions of the others", async () => {
  const a = await actor();
  const [c1, c3] = [await newCustomer(t.pool), await newCustomer(t.pool)];
  const e3 = await entry(c3, null, 3);
  const e1 = await entry(c1, null, 1);
  const e2 = await entry(null, "visitor@example.test", 2);
  const r = await asAdmin(a, (x) => x.waitlist.notifyNext({ ...OK, count: 2 }, "two units freed"));
  expect(r).toMatchObject({ ok: true, replayed: false });
  expect(r.ok && r.value.map((x) => x.id)).toEqual([e1, e2]);
  expect(r.ok && r.value[0]).toMatchObject({
    customerId: c1,
    email: null,
    productFamily: "linux_instance",
    region: REGION,
    reason: "capacity",
  });
  expect(r.ok && r.value[0]?.notifiedAt).toBeInstanceOf(Date);
  expect((await asAdmin(a, (x) => x.waitlist.list())).map((x) => [x.id, x.position])).toEqual([
    [e1, null],
    [e2, null],
    [e3, 1],
  ]);
  expect(await asAdmin(a, (x) => x.waitlist.notifyNext({ ...OK, count: 5 }, "rest"))).toMatchObject(
    { ok: true, value: [{ id: e3 }] },
  );
  expect(
    await asAdmin(a, (x) => x.waitlist.notifyNext({ ...OK, count: 5 }, "none left")),
  ).toMatchObject({ ok: true, replayed: true, value: [] });
  expect((await auditRowsOf(t.pool, a.adminId)).map((x) => x.metadata.after)).toEqual([
    { notified: [e1, e2] },
    { notified: [e3] },
    { notified: [] },
  ]);
});
it("skips a customer who bought the family in that Region since joining, and entries of other families, Regions and reasons", async () => {
  const a = await actor();
  const [bought, waiting] = [await newCustomer(t.pool), await newCustomer(t.pool)];
  await entry(bought, null, 1);
  await newResource(t.pool, bought, { region: REGION, created_at: "2026-11-01T01:00:00Z" });
  await entry(waiting, null, 2, { product_family: "managed_database" });
  await entry(waiting, null, 3, { region: "ap-south-1" });
  await entry(waiting, null, 4, { reason: "flag_off" });
  const mine = await entry(waiting, null, 5);
  const r = await asAdmin(a, (x) => x.waitlist.notifyNext({ ...OK, count: 10 }, "x"));
  expect(r.ok && r.value.map((x) => x.id)).toEqual([mine]);
  // the bought entry stays open but is served: no position, and it does not count in the positions of others
  const listed = await asAdmin(a, (x) => x.waitlist.list());
  expect(listed.map((x) => [x.served, x.position])).toEqual([
    [true, null],
    [false, 1],
    [false, 1],
    [false, 1],
    [false, null],
  ]);
});
it("refuses a bad request and a blank reason, and changes nothing", async () => {
  const a = await actor();
  const e = await entry(await newCustomer(t.pool), null, 1);
  const bad = [
    [{ ...OK, count: 0 }, "x"],
    [{ ...OK, count: 101 }, "x"],
    [{ ...OK, count: 1.5 }, "x"],
    [{ ...OK, productFamily: "Linux" }, "x"],
    [{ ...OK, region: "x" }, "x"],
    [{ ...OK, reason: "other" as never }, "x"],
    [OK, "   "],
  ] as const;
  for (const [input, why] of bad) {
    expect(await asAdmin(a, (x) => x.waitlist.notifyNext(input, why))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(
    (await t.pool.query("select notified_at from waitlist_entries where id = $1", [e])).rows[0]
      .notified_at,
  ).toBeNull();
  expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
});
it("two admins at the same moment take different entries: the second skips the row that the first still holds", async () => {
  const [a1, a2] = [await actor(), await actor()];
  const [e1, e2] = [
    await entry(await newCustomer(t.pool), null, 1),
    await entry(await newCustomer(t.pool), null, 2),
  ];
  // `skip locked` never waits, so holdUntilWaiter cannot gate this test. The first admin takes an entry and keeps its
  // transaction open until the second admin has answered, so the two transactions really overlap (no fixed sleep).
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstTook!: (ids: string[]) => void;
  const firstIds = new Promise<string[]>((resolve) => {
    firstTook = resolve;
  });
  const first = runTransaction(
    t.db,
    async (tx) => {
      const r = await adminRepos(tx, a1).waitlist.notifyNext(OK, "one unit freed");
      firstTook(r.ok ? r.value.map((x) => x.id) : []);
      await hold;
      return r;
    },
    { role: "admin_rw" },
  );
  try {
    const taken = await Promise.race([firstIds, first.then(() => [] as string[])]);
    expect(taken).toHaveLength(1);
    // without `skip locked` the second admin waits for the first and the guard below answers "blocked"
    const second = await Promise.race([
      asAdmin(a2, (x) => x.waitlist.notifyNext(OK, "one unit freed")),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5000)),
    ]);
    expect(second).toMatchObject({ ok: true });
    const ids = [
      ...taken,
      ...(second !== "blocked" && second.ok ? second.value.map((x) => x.id) : []),
    ];
    expect([...ids].sort()).toEqual([e1, e2].sort()); // no entry is taken twice
  } finally {
    release();
    await first;
  }
});
it("lists at most limit entries, oldest first, and the cursor continues after the entry it names", async () => {
  const a = await actor();
  const c = await newCustomer(t.pool);
  const e3 = await entry(c, null, 3);
  const e1 = await entry(c, null, 1);
  const e2 = await entry(c, null, 2);
  expect((await asAdmin(a, (x) => x.waitlist.list({ limit: 2 }))).map((x) => x.id)).toEqual([
    e1,
    e2,
  ]);
  const second = await asAdmin(a, (x) => x.waitlist.list({ limit: 2, after: e2 }));
  expect(second.map((x) => x.id)).toEqual([e3]);
  expect(second[0]?.position).toBe(3); // positions count all entries, not the page, and arrive as numbers
  for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { after: "x" }]) {
    await expect(asAdmin(a, (x) => x.waitlist.list(bad))).rejects.toBeInstanceOf(TypeError);
  }
});
