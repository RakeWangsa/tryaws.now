import { AwsError } from "@tc/aws";
import type { LogEvent } from "@tc/core";
import type { ReadTarget } from "@tc/db";
import { describe, expect, it } from "vitest";
import { claimActionOf } from "./deps";
import { createAccessDetails, type AccessDetailsDeps } from "./handler";
import { createInvoke } from "./invoke";

// WPU-N2: the database password and the bucket key, with the same proofs as the Windows password:
// ownership by the function's own read, the order of R9, no secret in any log or audit row, one key
// per request id.
const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const DB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const DB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const BUCKET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const BUCKET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const DB_STOPPED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const REQ = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const DB_SECRET = "tc-test-database-password-value-777";
const KEY_SECRET = "tc-test-bucket-secret-key-value-888";
const POOL_ACCOUNT = "210987654321";
const EXTERNAL_ID = "tc-ext-7f3a9c";

function target(id: string, family: string, state = "active"): ReadTarget {
  return {
    resource: { id, family, state } as unknown as ReadTarget["resource"],
    account: { awsAccountId: POOL_ACCOUNT, externalId: EXTERNAL_ID },
    region: "ap-southeast-1",
  };
}

const rows: Record<string, { owner: string; target: ReadTarget }> = {
  [DB_A]: { owner: CUSTOMER_A, target: target(DB_A, "database") },
  [DB_B]: { owner: CUSTOMER_B, target: target(DB_B, "database") },
  [DB_STOPPED]: { owner: CUSTOMER_A, target: target(DB_STOPPED, "database", "stopped") },
  [BUCKET_A]: { owner: CUSTOMER_A, target: target(BUCKET_A, "bucket") },
  [BUCKET_B]: { owner: CUSTOMER_B, target: target(BUCKET_B, "bucket") },
};

function setup(over: Partial<AccessDetailsDeps> = {}) {
  const order: string[] = [];
  const logged: LogEvent[] = [];
  const audits: unknown[] = [];
  const claimed = new Set<string>();
  const rates: string[] = [];
  const deps: AccessDetailsDeps = {
    loadTarget: async (caller, resourceId) => {
      order.push("load");
      const row = rows[resourceId];
      return row !== undefined && row.owner === caller.customerId ? row.target : null;
    },
    rateLimit: async (_c, action) => {
      order.push("limit");
      rates.push(action);
      return true;
    },
    windowsPassword: async () => {
      throw new Error("not used");
    },
    databasePassword: async () => {
      order.push("fetch");
      return { username: "tcadmin", password: DB_SECRET };
    },
    bucketKeyCreate: async () => {
      order.push("create");
      return { accessKeyId: "AKIAFAKEKEYNEW00001", secretAccessKey: KEY_SECRET };
    },
    bucketKeyList: async () => {
      order.push("list");
      return [{ accessKeyId: "AKIAFAKEKEYNEW00001", status: "active", createdAt: null }];
    },
    claimRequest: async (customerId, requestId) => {
      order.push("claim");
      const k = `${customerId}:${requestId}`;
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    audit: async (entry) => {
      order.push("audit");
      audits.push(entry);
    },
    log: (e) => logged.push(e),
    ...over,
  };
  return { access: createAccessDetails(deps), order, logged, audits, rates };
}

const A = { customerId: CUSTOMER_A };
const B = { customerId: CUSTOMER_B };

describe("databasePassword", () => {
  it("answers in the order of R9 and returns the secret with no-store", async () => {
    const { access, order, rates } = setup();
    const r = await access.databasePassword(DB_A, A);
    expect(r).toEqual({
      ok: true,
      value: { username: "tcadmin", password: DB_SECRET },
      cacheControl: "no-store",
    });
    expect(order).toEqual(["load", "limit", "fetch", "audit"]);
    expect(rates).toEqual(["database_password.reveal"]);
  });

  it("gives another customer's database the answer of a missing one, never asking AWS", async () => {
    const { access, order } = setup();
    const other = await access.databasePassword(DB_A, B);
    const missing = await access.databasePassword("cccccccc-cccc-4ccc-8ccc-cccccccccccc", B);
    expect(other).toEqual({ ok: false, error: "not_found" });
    expect(other).toEqual(missing);
    expect(order).not.toContain("fetch");
    expect(order).not.toContain("audit");
    expect(order).not.toContain("limit");
  });

  it("refuses a bucket id, a database that is not running, and a rate limit, before AWS", async () => {
    const s = setup();
    expect(await s.access.databasePassword(BUCKET_A, A)).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await s.access.databasePassword(DB_STOPPED, A)).toEqual({
      ok: false,
      error: "conflict",
    });
    const limited = setup({ rateLimit: async () => false });
    expect(await limited.access.databasePassword(DB_A, A)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    for (const x of [s, limited]) expect(x.order).not.toContain("fetch");
  });

  it("returns no secret when the audit row cannot be written (R16)", async () => {
    const { access } = setup({
      audit: async () => {
        throw new Error(`db down ${DB_SECRET}`);
      },
    });
    const r = await access.databasePassword(DB_A, A);
    expect(r).toEqual({ ok: false, error: "internal" });
    expect(JSON.stringify(r)).not.toContain(DB_SECRET);
  });
});

describe("bucketKeyCreate", () => {
  it("claims the request id, audits, then makes the key, and shows the secret once", async () => {
    const { access, order, rates } = setup();
    const r = await access.bucketKeyCreate(BUCKET_A, REQ, A);
    expect(r).toEqual({
      ok: true,
      value: { accessKeyId: "AKIAFAKEKEYNEW00001", secretAccessKey: KEY_SECRET },
      cacheControl: "no-store",
    });
    expect(order).toEqual(["load", "limit", "claim", "audit", "create"]);
    expect(rates).toEqual(["bucket_key.create"]);
  });

  it("a double submit of the same request id creates one key and says it cannot be shown again", async () => {
    const { access, order } = setup();
    const first = await access.bucketKeyCreate(BUCKET_A, REQ, A);
    const second = await access.bucketKeyCreate(BUCKET_A, REQ, A);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "already_created" });
    expect(order.filter((x) => x === "create")).toHaveLength(1);
    // a new request id is a new key
    const third = await access.bucketKeyCreate(BUCKET_A, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2", A);
    expect(third.ok).toBe(true);
  });

  it("the claim is not made for a foreign bucket, a bad request id or a bucket that is not active", async () => {
    const claims: string[] = [];
    const { access, order } = setup({
      claimRequest: async (_c, r) => {
        claims.push(r);
        return true;
      },
    });
    expect(await access.bucketKeyCreate(BUCKET_A, REQ, B)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await access.bucketKeyCreate(BUCKET_A, "nope", A)).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await access.bucketKeyCreate(DB_A, REQ, A)).toEqual({ ok: false, error: "validation" });
    expect(claims).toEqual([]);
    expect(order).not.toContain("create");
  });

  it("makes no key when the audit row fails (R16) and maps the limit of two keys", async () => {
    const failing = setup({
      audit: async () => {
        throw new Error("down");
      },
    });
    expect(await failing.access.bucketKeyCreate(BUCKET_A, REQ, A)).toEqual({
      ok: false,
      error: "internal",
    });
    expect(failing.order).not.toContain("create");
    const full = setup({
      bucketKeyCreate: async () => {
        throw new AwsError({ code: "limit_reached", retryable: false });
      },
    });
    expect(await full.access.bucketKeyCreate(BUCKET_A, REQ, A)).toEqual({
      ok: false,
      error: "limit_reached",
    });
  });
});

describe("bucketKeyList", () => {
  it("lists after the ownership check, with no audit row, and nothing for a foreign bucket", async () => {
    const { access, order } = setup();
    const r = await access.bucketKeyList(BUCKET_A, A);
    expect(r).toEqual({
      ok: true,
      value: { keys: [{ accessKeyId: "AKIAFAKEKEYNEW00001", status: "active", createdAt: null }] },
    });
    expect(order).toEqual(["load", "limit", "list"]);
    const foreign = await access.bucketKeyList(BUCKET_B, A);
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(order.filter((x) => x === "list")).toHaveLength(1);
  });
});

describe("no secret in logs or audit rows", () => {
  it("scans every captured log line and audit entry for the planted secrets", async () => {
    const { access, logged, audits } = setup();
    const results = [
      await access.databasePassword(DB_A, A),
      await access.databasePassword(DB_A, B),
      await access.bucketKeyCreate(BUCKET_A, REQ, A),
      await access.bucketKeyCreate(BUCKET_A, REQ, A),
      await access.bucketKeyList(BUCKET_A, A),
    ];
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(logged.length).toBe(5);
    // logs: fixed words only. Audit rows: ids (their job), never a secret, key id or pool detail.
    const secrets = [DB_SECRET, KEY_SECRET, "AKIAFAKEKEYNEW00001", POOL_ACCOUNT, EXTERNAL_ID, REQ];
    for (const planted of [...secrets, CUSTOMER_A, CUSTOMER_B, DB_A, BUCKET_A]) {
      expect(JSON.stringify(logged)).not.toContain(planted);
    }
    for (const planted of secrets) expect(JSON.stringify(audits)).not.toContain(planted);
    expect(audits).toEqual([
      { customerId: CUSTOMER_A, action: "database_password.reveal", resourceId: DB_A },
      { customerId: CUSTOMER_A, action: "bucket_key.create", resourceId: BUCKET_A },
    ]);
  });

  it("an error thrown with the secret in its text leaves no trace in the answer or the log", async () => {
    const { access, logged } = setup({
      databasePassword: async () => {
        throw new Error(`boom ${DB_SECRET}`);
      },
    });
    const r = await access.databasePassword(DB_A, A);
    expect(r).toEqual({ ok: false, error: "internal" });
    expect(JSON.stringify([r, logged])).not.toContain(DB_SECRET);
  });
});

describe("tiers through the invoke", () => {
  it("the admin alias gets no secret and no lookup for any customer action", async () => {
    const { access, order } = setup();
    const invoke = createInvoke(access);
    for (const action of ["database_password", "bucket_key_list"]) {
      const r = await invoke({ action, resourceId: DB_A, caller: A }, "admin");
      expect(r).toEqual({ ok: false, error: "unauthenticated" });
    }
    const c = await invoke(
      { action: "bucket_key_create", resourceId: BUCKET_A, requestId: REQ, caller: A },
      "admin",
    );
    expect(c).toEqual({ ok: false, error: "unauthenticated" });
    expect(order).toEqual([]);
  });
});

describe("claimActionOf", () => {
  it("makes a valid rate-limit action of at most 48 characters from the request id", () => {
    const action = claimActionOf(REQ);
    expect(action).toMatch(/^[a-z][a-z0-9_.]{0,47}$/);
    expect(claimActionOf(REQ)).not.toBe(claimActionOf("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2"));
  });
});
