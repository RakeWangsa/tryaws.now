import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, insertRow } from "./sql";
import { newAdmin, newCustomer } from "./fixtures";
import { columnTests } from "./expected-columns";

const t = useTempDatabase();
columnTests(
  () => t.pool,
  [
    "customers",
    "kyc_submissions",
    "ssh_keys",
    "otp_challenges",
    "rate_limits",
    "legal_acceptances",
  ],
);

it("customers start with no KYC, tier new, Bengali, active, and no session cut-off", async () => {
  const id = await newCustomer(t.pool);
  const { rows } = await t.pool.query(
    "select kyc_status, risk_tier, locale, status, sessions_valid_after from customers where id = $1",
    [id],
  );
  expect(rows[0]).toEqual({
    kyc_status: "none",
    risk_tier: "new",
    locale: "bn",
    status: "active",
    sessions_valid_after: null,
  });
});

it.each<[string, Record<string, unknown>, string, string?]>([
  ["an unknown KYC status", { kyc_status: "approved" }, "23514", "customers_kyc_status_check"],
  ["an unknown tier", { risk_tier: "gold" }, "23514", "customers_risk_tier_check"],
  ["an unknown locale", { locale: "fr" }, "23514", "customers_locale_check"],
  ["an unknown status", { status: "closed" }, "23514", "customers_status_check"],
  ["an unknown type", { type: "charity" }, "23514", "customers_type_check"],
  ["an unknown market", { market: "XX" }, "23503", undefined],
])("customers refuse %s", async (_, over, code, constraint) => {
  await expectSqlError(newCustomer(t.pool, over), code, constraint ? { constraint } : undefined);
});

it("customers are unique per Cognito sub", async () => {
  await newCustomer(t.pool, { cognito_sub: "sub-1" });
  await expectSqlError(newCustomer(t.pool, { cognito_sub: "sub-1" }), "23505", {
    constraint: "customers_cognito_sub_unique",
  });
});

it("a reviewed KYC submission names its reviewer and time", async () => {
  const customer_id = await newCustomer(t.pool);
  const row = {
    customer_id,
    document_type: "nid",
    document_number_encrypted: Buffer.from([1, 2, 3]),
    s3_keys: ["kyc/a/front.jpg"],
  };
  await insertRow(t.pool, "kyc_submissions", row);
  await expectSqlError(
    insertRow(t.pool, "kyc_submissions", { ...row, status: "verified" }),
    "23514",
    { constraint: "kyc_submissions_review_check" },
  );
  const reviewer_id = await newAdmin(t.pool, "support");
  await insertRow(t.pool, "kyc_submissions", {
    ...row,
    status: "verified",
    reviewer_id,
    reviewed_at: "2026-11-11T10:00:00Z",
  });
  await expectSqlError(insertRow(t.pool, "kyc_submissions", { ...row, s3_keys: [] }), "23514", {
    constraint: "kyc_submissions_s3_keys_check",
  });
});

it("an SSH key fingerprint is unique per customer, not across customers", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const key = { name: "laptop", public_key: "ssh-rsa AAAA", fingerprint: "SHA256:abc" };
  await insertRow(t.pool, "ssh_keys", { ...key, customer_id: a });
  await insertRow(t.pool, "ssh_keys", { ...key, customer_id: b });
  await expectSqlError(insertRow(t.pool, "ssh_keys", { ...key, customer_id: a }), "23505", {
    constraint: "ssh_keys_customer_id_fingerprint_unique",
  });
});

it("one rate-limit row per scope key and window", async () => {
  const row = { scope_key: "otp:phone:9f86d0", window_start: "2026-11-11T10:00:00Z" };
  const id = await insertRow(t.pool, "rate_limits", row);
  expect(
    (await t.pool.query("select count from rate_limits where id = $1", [id])).rows[0].count,
  ).toBe(0);
  await expectSqlError(insertRow(t.pool, "rate_limits", row), "23505", {
    constraint: "rate_limits_scope_key_window_start_unique",
  });
  await expectSqlError(
    insertRow(t.pool, "rate_limits", { ...row, scope_key: "x", count: -1 }),
    "23514",
    { constraint: "rate_limits_count_check" },
  );
});

it("OTP challenges start with 0 attempts", async () => {
  const customer_id = await newCustomer(t.pool);
  const id = await insertRow(t.pool, "otp_challenges", {
    customer_id,
    phone: "+8801700000000",
    code_hash: "h",
    expires_at: "2026-11-11T10:05:00Z",
  });
  expect(
    (await t.pool.query("select attempts, consumed_at from otp_challenges where id = $1", [id]))
      .rows[0],
  ).toEqual({ attempts: 0, consumed_at: null });
});

it("legal acceptances take the five documents and an IPv4 or IPv6 address", async () => {
  const customer_id = await newCustomer(t.pool);
  const row = { customer_id, document: "terms", version: "1.0", ip: "203.0.113.7" };
  await insertRow(t.pool, "legal_acceptances", row);
  await insertRow(t.pool, "legal_acceptances", {
    ...row,
    document: "domain_registration",
    ip: "2001:db8::1",
  });
  await insertRow(t.pool, "legal_acceptances", {
    ...row,
    document: "domain_registration",
    ip: "2001:db8::1",
  });
  await expectSqlError(
    insertRow(t.pool, "legal_acceptances", { ...row, document: "cookies" }),
    "23514",
    { constraint: "legal_acceptances_document_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "legal_acceptances", { ...row, ip: "not-an-ip" }),
    "22P02",
  );
});
