import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer } from "./fixtures";
import { asRole, expectSqlError } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(customerId: string, fn: Parameters<typeof withCustomerRepos<T>>[2]) =>
  withCustomerRepos(t.db, customerId, fn);

const submission = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  documentType: "nid",
  documentNumberEncrypted: Buffer.from("sealed-number"),
  s3Keys: ["kyc/a/b/0.jpg", "kyc/a/b/1.pdf"],
  ...over,
});

it("a customer without a submission has none", async () => {
  const id = await newCustomer(t.pool);
  expect(await as(id, (r) => r.kyc.latest())).toBeNull();
});

it("submit stores a pending submission and the view holds no key and no number", async () => {
  const id = await newCustomer(t.pool);
  const input = submission();
  const res = await as(id, (r) => r.kyc.submit(input));
  expect(res.ok && !res.replayed).toBe(true);
  const view = await as(id, (r) => r.kyc.latest());
  expect(view).toMatchObject({ id: input.id, documentType: "nid", status: "pending" });
  expect(Object.keys(view!).sort()).toEqual([
    "createdAt",
    "documentType",
    "id",
    "note",
    "reviewedAt",
    "status",
  ]);
  const stored = await t.pool.query(
    "select s3_keys, document_number_encrypted from kyc_submissions where id = $1",
    [input.id],
  );
  expect(stored.rows[0].s3_keys).toEqual(input.s3Keys);
  expect(Buffer.from(stored.rows[0].document_number_encrypted).toString()).toBe("sealed-number");
});

it("the same submission id again is a replay and adds no row (R7)", async () => {
  const id = await newCustomer(t.pool);
  const input = submission();
  await as(id, (r) => r.kyc.submit(input));
  const again = await as(id, (r) => r.kyc.submit(input));
  expect(again.ok && again.replayed).toBe(true);
  const count = await t.pool.query(
    "select count(*)::int as n from kyc_submissions where customer_id = $1",
    [id],
  );
  expect(count.rows[0].n).toBe(1);
});

it("a second submission while one is pending is a conflict", async () => {
  const id = await newCustomer(t.pool);
  await as(id, (r) => r.kyc.submit(submission()));
  const second = await as(id, (r) => r.kyc.submit(submission()));
  expect(second).toEqual({ ok: false, error: "conflict" });
});

it("two submits at once leave one open submission", async () => {
  const id = await newCustomer(t.pool);
  const results = await Promise.all([
    as(id, (r) => r.kyc.submit(submission())),
    as(id, (r) => r.kyc.submit(submission())),
  ]);
  expect(results.filter((x) => x.ok)).toHaveLength(1);
  const count = await t.pool.query(
    "select count(*)::int as n from kyc_submissions where customer_id = $1",
    [id],
  );
  expect(count.rows[0].n).toBe(1);
});

it("a rejected customer may submit again; a verified one may not", async () => {
  const rejected = await newCustomer(t.pool);
  const first = submission();
  await as(rejected, (r) => r.kyc.submit(first));
  const reviewer = (
    await t.pool.query(
      "insert into admin_users (id, cognito_sub, role) values ($1, $2, 'support') returning id",
      [uuidv7(), "adm-" + uuidv7()],
    )
  ).rows[0].id;
  await t.pool.query(
    "update kyc_submissions set status='rejected', reviewer_id=$2, reviewed_at=now(), note='blurry' where id=$1",
    [first.id, reviewer],
  );
  expect(await as(rejected, (r) => r.kyc.latest())).toMatchObject({
    status: "rejected",
    note: "blurry",
  });
  const again = await as(rejected, (r) => r.kyc.submit(submission()));
  expect(again.ok).toBe(true);

  const verified = await newCustomer(t.pool, { kyc_status: "verified" });
  expect(await as(verified, (r) => r.kyc.submit(submission()))).toEqual({
    ok: false,
    error: "conflict",
  });
});

it("refuses a malformed submission before any query", async () => {
  const id = await newCustomer(t.pool);
  for (const bad of [
    submission({ id: "x" }),
    submission({ s3Keys: [] }),
    submission({ documentNumberEncrypted: new Uint8Array() }),
    submission({ documentType: "" }),
  ]) {
    expect(await as(id, (r) => r.kyc.submit(bad))).toEqual({ ok: false, error: "validation" });
  }
});

it("another customer's submission id is a conflict and reveals nothing", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const input = submission();
  await as(a, (r) => r.kyc.submit(input));
  expect(await as(b, (r) => r.kyc.submit(input))).toEqual({ ok: false, error: "conflict" });
  expect(await as(b, (r) => r.kyc.latest())).toBeNull();
});

it("setType sets the account type and is idempotent", async () => {
  const id = await newCustomer(t.pool);
  expect(await as(id, (r) => r.kyc.setType("business"))).toMatchObject({ ok: true });
  expect(await as(id, (r) => r.kyc.setType("business"))).toMatchObject({ ok: true });
  expect((await as(id, (r) => r.profile.get()))?.type).toBe("business");
  expect(await as(id, (r) => r.kyc.setType("x" as never))).toEqual({
    ok: false,
    error: "validation",
  });
});

it("the web role cannot read the keys or the number of a submission (42501)", async () => {
  const id = await newCustomer(t.pool);
  await as(id, (r) => r.kyc.submit(submission()));
  for (const column of ["s3_keys", "document_number_encrypted", "reviewer_id"]) {
    await expectSqlError(
      asRole(t.pool, "web_rw", (c) => c.query(`select ${column} from kyc_submissions`)),
      "42501",
    );
  }
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) => c.query("update kyc_submissions set status = 'verified'")),
    "42501",
  );
  await expectSqlError(
    asRole(t.pool, "web_rw", (c) => c.query("update customers set kyc_status = 'verified'")),
    "42501",
  );
});
