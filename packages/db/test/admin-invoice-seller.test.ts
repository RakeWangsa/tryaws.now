import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import {
  parseSellerFields,
  parseSellerRowValue,
  readInvoiceSeller,
} from "../repositories/config/invoice-seller";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-I1: the seller of the tax invoices is one setting per market, written by finance and superadmin
// through `audited`, versioned by a counter, and never seeded.
const t = useTempDatabase();
let finance: AdminActor;
let ops: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  finance = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "test",
  };
  ops = { adminId: await newAdmin(t.pool, "ops"), role: "ops", ip: "203.0.113.10", userAgent: "t" };
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, a: AdminActor = finance) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const seller = {
  legalNameBn: "পরীক্ষা লিমিটেড",
  legalNameEn: "Test Limited",
  bin: "0000000000000",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  signatoryName: "Test Signatory",
  signatoryDesignation: "Director",
};
const stored = async () =>
  (await t.pool.query("select scope, scope_id, value from settings where key = 'invoice_seller'"))
    .rows;
const readAs = () => runTransaction(t.db, (tx) => readInvoiceSeller(tx, "BD"), { role: "web_rw" });

it("parses a complete value and refuses a missing field, a short BIN and a bad version", () => {
  expect(parseSellerFields(seller)).toEqual(seller);
  expect(parseSellerRowValue({ v: 1, version: 3, ...seller })).toEqual({ seller, version: 3 });
  for (const bad of [
    { ...seller, bin: "123" },
    { ...seller, bin: "০০০০০০০০০০০০০" },
    { ...seller, addressEn: "" },
    { ...seller, email: "nope" },
  ]) {
    expect(parseSellerFields(bad), JSON.stringify(bad)).toBeNull();
  }
  for (const bad of [
    { ...seller },
    { v: 2, version: 1, ...seller },
    { v: 1, version: 0, ...seller },
    { v: 1, version: 1.5, ...seller },
  ]) {
    expect(parseSellerRowValue(bad), JSON.stringify(bad)).toBeNull();
  }
});

it("nothing is seeded: no row reads as none", async () => {
  expect(await readAs()).toEqual({ state: "none" });
  expect(await as((r) => r.invoiceSeller.read("BD"))).toMatchObject({
    ok: true,
    value: { state: "none" },
  });
});

it("a save writes one market row at version 1 and audits actor, reason, IP and target", async () => {
  const saved = await as((r) =>
    r.invoiceSeller.save({ market: "BD", seller }, "details from the registration certificate"),
  );
  expect(saved).toMatchObject({ ok: true, replayed: false, value: { version: 1 } });
  expect(await stored()).toEqual([
    { scope: "market", scope_id: null, value: { v: 1, version: 1, ...seller } },
  ]);
  const audits = (await auditRowsOf(t.pool, finance.adminId)).filter(
    (a) => a.action === "invoice_seller.save",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    target_type: "invoice_seller",
    target_id: "BD",
    ip: "203.0.113.9",
  });
  expect(audits[0]?.metadata.reason).toBe("details from the registration certificate");
  expect(await readAs()).toEqual({ state: "ok", seller, version: 1 });
});

it("the same details again are a replay; a change raises the version and keeps the old value in the audit log", async () => {
  expect(
    await as((r) => r.invoiceSeller.save({ market: "BD", seller }, "again, nothing changed")),
  ).toMatchObject({ ok: true, replayed: true, value: { version: 1 } });
  const changed = { ...seller, addressEn: "Gulshan, Dhaka", vatCircle: "Dhaka South" };
  expect(
    await as((r) => r.invoiceSeller.save({ market: "BD", seller: changed }, "moved office")),
  ).toMatchObject({ ok: true, replayed: false, value: { version: 2 } });
  expect(await readAs()).toEqual({ state: "ok", seller: changed, version: 2 });
  const audits = (await auditRowsOf(t.pool, finance.adminId)).filter(
    (a) => a.action === "invoice_seller.save",
  );
  expect(audits.map((a) => a.metadata.before)).toContainEqual(
    expect.objectContaining({ addressEn: "Dhaka" }),
  );
});

it("refuses an incomplete seller, another role and an unknown market; nothing is written", async () => {
  const before = await stored();
  expect(
    await as((r) =>
      r.invoiceSeller.save({ market: "BD", seller: { ...seller, bin: "12" } }, "bad bin"),
    ),
  ).toEqual({ ok: false, error: "validation" });
  expect(await as((r) => r.invoiceSeller.save({ market: "BD", seller }, "ops tries"), ops)).toEqual(
    { ok: false, error: "forbidden" },
  );
  expect(await as((r) => r.invoiceSeller.read("BD"), ops)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await as((r) => r.invoiceSeller.save({ market: "xx", seller }, "bad market"))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await stored()).toEqual(before);
});

it("a stored row that does not parse reads as invalid, and a save replaces it", async () => {
  await t.pool.query(
    `update settings set value = '{"v":1,"version":9,"bin":"1"}'::jsonb where key = 'invoice_seller'`,
  );
  expect(await readAs()).toEqual({ state: "invalid" });
  expect(
    await as((r) => r.invoiceSeller.save({ market: "BD", seller }, "fix the row")),
  ).toMatchObject({ ok: true, replayed: false, value: { version: 10 } });
  expect(await readAs()).toMatchObject({ state: "ok", version: 10 });
});
