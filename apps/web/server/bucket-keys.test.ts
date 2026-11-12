import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { createBucketKeyCore, listBucketKeysCore, type BucketKeysDeps } from "./bucket-keys.ts";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BUCKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const SECRET = "tc-test-bucket-secret-value-123";

const session = (over: Partial<CustomerSession> = {}): CustomerSession =>
  ({
    customerId: CUSTOMER,
    signedInAt: new Date(NOW.getTime() - 60_000),
    ...over,
  }) as CustomerSession;

function setup(over: Partial<BucketKeysDeps> = {}) {
  const order: string[] = [];
  const asked: unknown[] = [];
  const deps: BucketKeysDeps = {
    authenticate: async () => {
      order.push("authenticate");
      return session();
    },
    now: () => NOW,
    ownedBucket: async (customerId, bucketId) => {
      order.push("owned");
      return customerId === CUSTOMER && bucketId === BUCKET
        ? { state: "active", name: "Site assets" }
        : null;
    },
    rateLimit: async () => {
      order.push("limit");
      return true;
    },
    listKeys: async (input) => {
      order.push("list");
      asked.push(input);
      return {
        ok: true,
        value: {
          keys: [{ accessKeyId: "AKIAEXAMPLEKEY123456", status: "active", createdAt: null }],
        },
      };
    },
    createKey: async (input) => {
      order.push("create");
      asked.push(input);
      return { ok: true, value: { accessKeyId: "AKIAEXAMPLEKEY123456", secretAccessKey: SECRET } };
    },
    ...over,
  };
  return { deps, order, asked };
}

const NAME = "Site assets";
const input = { bucketId: BUCKET, requestId: REQ, confirmName: NAME };

describe("createBucketKeyCore (U9)", () => {
  it("runs in the order of R9 and returns the secret flagged no-store", async () => {
    const { deps, order } = setup();
    expect(await createBucketKeyCore(deps, input)).toEqual({
      ok: true,
      accessKeyId: "AKIAEXAMPLEKEY123456",
      secretAccessKey: SECRET,
      cacheControl: "no-store",
    });
    expect(order).toEqual(["authenticate", "owned", "limit", "create"]);
  });

  it("takes the customer from the session, never from the input (R8), and passes the request id (R7)", async () => {
    const { deps, asked } = setup();
    await createBucketKeyCore(deps, { ...input, customerId: "evil" });
    expect(asked).toEqual([{ customerId: CUSTOMER, resourceId: BUCKET, requestId: REQ }]);
  });

  it("refuses without a session and without a fresh sign-in before anything else", async () => {
    const none = setup({ authenticate: async () => null });
    expect(await createBucketKeyCore(none.deps, input)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const stale = setup({
      authenticate: async () => session({ signedInAt: new Date(NOW.getTime() - 3_600_000) }),
    });
    expect(await createBucketKeyCore(stale.deps, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(none.order).toEqual([]);
    expect(stale.order).toEqual([]);
  });

  it("refuses ids that are not UUIDs without limiting or creating", async () => {
    const { deps, order } = setup();
    for (const raw of [{}, null, { bucketId: 5, requestId: REQ }, { bucketId: BUCKET }]) {
      expect(await createBucketKeyCore(deps, raw)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(order).toEqual(["authenticate", "authenticate", "authenticate", "authenticate"]);
  });

  it("fails closed when the transport is not wired, and when the limit is used up", async () => {
    const unwired = setup({ createKey: null });
    expect(await createBucketKeyCore(unwired.deps, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
    const limited = setup({ rateLimit: async () => false });
    expect(await createBucketKeyCore(limited.deps, input)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.order).toEqual(["authenticate", "owned"]);
  });

  it("maps what the function answers to public keys and drops its text (U6)", async () => {
    const map = async (error: string) =>
      createBucketKeyCore(setup({ createKey: async () => ({ ok: false, error }) }).deps, input);
    expect(await map("not_found")).toEqual({ ok: false, error: "not_found" });
    expect(await map("conflict")).toEqual({ ok: false, error: "not_ready" });
    expect(await map("limit_reached")).toEqual({ ok: false, error: "limit_reached" });
    expect(await map("rate_limited")).toEqual({ ok: false, error: "rate_limited" });
    expect(await map("InvalidClientTokenId arn:aws:iam::123456789012:role/x")).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("never puts the secret in an error, and a thrown port gives `unavailable` without its text", async () => {
    const thrown = setup({
      createKey: async () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const r = await createBucketKeyCore(thrown.deps, input);
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("another customer's bucket and a missing one give one answer and never reach the port (R8)", async () => {
    const other = setup({ authenticate: async () => session({ customerId: "other" }) });
    const missing = setup({ ownedBucket: async () => null });
    const a = await createBucketKeyCore(other.deps, input);
    const b = await createBucketKeyCore(missing.deps, input);
    expect(a).toEqual({ ok: false, error: "not_found" });
    expect(b).toEqual(a);
    expect(other.order).not.toContain("create");
    expect(missing.order).not.toContain("create");
    expect(missing.order).not.toContain("limit");
  });

  it("needs the typed bucket name, and a bucket that is on (U10)", async () => {
    for (const confirmName of [undefined, "", "site assets", "x"]) {
      const w = setup();
      expect(await createBucketKeyCore(w.deps, { ...input, confirmName })).toEqual({
        ok: false,
        error: "name_mismatch",
      });
      expect(w.order).not.toContain("create");
      expect(w.order).not.toContain("limit");
    }
    const off = setup({ ownedBucket: async () => ({ state: "suspended", name: NAME }) });
    expect(await createBucketKeyCore(off.deps, input)).toEqual({ ok: false, error: "not_ready" });
    expect(off.order).not.toContain("create");
  });

  it("a double submit: the function says already created and the core passes that on, no secret", async () => {
    const w = setup({ createKey: async () => ({ ok: false, error: "already_created" }) });
    const r = await createBucketKeyCore(w.deps, input);
    expect(r).toEqual({ ok: false, error: "already_created" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("listBucketKeysCore", () => {
  it("lists the keys of the customer's own bucket after ownership and the limit", async () => {
    const { deps, order } = setup();
    expect(await listBucketKeysCore(deps, { bucketId: BUCKET })).toEqual({
      ok: true,
      keys: [{ accessKeyId: "AKIAEXAMPLEKEY123456", status: "active", createdAt: null }],
    });
    expect(order).toEqual(["authenticate", "owned", "limit", "list"]);
  });

  it("another customer's bucket gives the answer of a missing one and the port is not reached (R8)", async () => {
    const other = setup({ authenticate: async () => session({ customerId: "other" }) });
    expect(await listBucketKeysCore(other.deps, { bucketId: BUCKET })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(other.order).not.toContain("list");
  });

  it("fails closed: no session, a bad id, no transport, a port that throws", async () => {
    expect(
      await listBucketKeysCore(setup({ authenticate: async () => null }).deps, {
        bucketId: BUCKET,
      }),
    ).toEqual({ ok: false, error: "unauthenticated" });
    expect(await listBucketKeysCore(setup().deps, { bucketId: "x" })).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await listBucketKeysCore(setup({ listKeys: null }).deps, { bucketId: BUCKET })).toEqual({
      ok: false,
      error: "unavailable",
    });
    const thrown = setup({
      listKeys: async () => {
        throw new Error("arn:aws:x");
      },
    });
    expect(await listBucketKeysCore(thrown.deps, { bucketId: BUCKET })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
