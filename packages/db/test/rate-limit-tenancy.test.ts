import { expect, it } from "vitest";
import { consumeRateLimits, limitKey } from "../repositories/rate-limit";
import type { CustomerRepos } from "../repositories/customer/index";
import { NON_TENANT_TABLES, TENANT_TABLES } from "../tenancy";
import { withCustomerRepos } from "../testing/repos";
import { tenantSnapshot } from "../testing/snapshot";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const NOW = new Date("2026-11-11T10:00:00.000Z");
const topup = [{ action: "topup.start", limit: 2, windowSeconds: 3600 }];
const keysOf = async (id: string) =>
  (await tenantSnapshot(t.pool, id)).rate_limits!.map((row) => JSON.parse(row).scope_key as string);

it("rate_limits is a tenant table owned through the prefix customer:<id>:", () => {
  expect(TENANT_TABLES.rate_limits).toBe(
    "starts_with(t.scope_key, 'customer:' || $1::uuid::text || ':')",
  );
  expect(NON_TENANT_TABLES).not.toContain("rate_limits");
});

it("a snapshot holds the limit rows of its customer, none of another customer, and none of a phone, an IP or an email", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  await as(a, (r) => r.rateLimits.consume(topup, NOW));
  await as(b, (r) => r.rateLimits.consume(topup, NOW));
  await runTransaction(
    t.db,
    (tx) =>
      consumeRateLimits(
        tx,
        [
          {
            kind: "phone",
            subject: "a".repeat(32),
            action: "otp.send",
            limit: 3,
            windowSeconds: 3600,
          },
          {
            kind: "ip",
            subject: "b".repeat(32),
            action: "otp.send",
            limit: 3,
            windowSeconds: 3600,
          },
          {
            kind: "email",
            subject: "c".repeat(32),
            action: "signin",
            limit: 3,
            windowSeconds: 3600,
          },
        ],
        NOW,
      ),
    { role: "web_rw" },
  );
  expect(await keysOf(a)).toEqual([limitKey("customer", a, "topup.start", 3600)]);
  expect(await keysOf(b)).toEqual([limitKey("customer", b, "topup.start", 3600)]);
});

it("the key comes from the bound scope: an upper-case id is the same row, and every customer has its own quota", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  expect(await as(a.toUpperCase(), (r) => r.rateLimits.consume(topup, NOW))).toEqual({
    allowed: true,
  });
  expect(await as(a, (r) => r.rateLimits.consume(topup, NOW))).toEqual({ allowed: true });
  expect(await as(a, (r) => r.rateLimits.consume(topup, NOW))).toEqual({
    allowed: false,
    action: "topup.start",
    retryAfterSeconds: 3600,
  });
  expect(await as(b, (r) => r.rateLimits.consume(topup, NOW))).toEqual({ allowed: true });
  expect(await keysOf(a)).toEqual([limitKey("customer", a, "topup.start", 3600)]);
});

it("limits apply in order of key, the first refusing one is reported, and an invalid limit is a TypeError", async () => {
  const c = await newCustomer(t.pool);
  const two = [
    { action: "b.second", limit: 1, windowSeconds: 60 },
    { action: "a.first", limit: 5, windowSeconds: 3600 },
  ];
  expect(await as(c, (r) => r.rateLimits.consume(two, NOW))).toEqual({ allowed: true });
  expect(await as(c, (r) => r.rateLimits.consume(two, NOW))).toEqual({
    allowed: false,
    action: "b.second",
    retryAfterSeconds: 60,
  });
  for (const bad of [
    [],
    [{ action: "Bad", limit: 1, windowSeconds: 60 }],
    [{ action: "x", limit: 0, windowSeconds: 60 }],
  ]) {
    await expect(as(c, (r) => r.rateLimits.consume(bad, NOW))).rejects.toThrow(TypeError);
  }
});
