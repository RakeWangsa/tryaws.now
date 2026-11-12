import { AwsError } from "@tc/aws";
import type { LogEvent } from "@tc/core";
import type { ReadTarget } from "@tc/db";
import { describe, expect, it } from "vitest";
import { createAccessDetails, type AccessDetailsDeps } from "./handler";

const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const WIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WIN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINUX_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GHOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "tc-test-windows-password-value-123";
const POOL_ACCOUNT = "210987654321";
const EXTERNAL_ID = "tc-ext-7f3a9c";

function target(id: string, family = "windows_instance", state = "active"): ReadTarget {
  return {
    resource: { id, family, state } as unknown as ReadTarget["resource"],
    account: { awsAccountId: POOL_ACCOUNT, externalId: EXTERNAL_ID },
    region: "ap-southeast-1",
  };
}

const rows: Record<string, { owner: string; target: ReadTarget }> = {
  [WIN_A]: { owner: CUSTOMER_A, target: target(WIN_A) },
  [WIN_B]: { owner: CUSTOMER_B, target: target(WIN_B) },
  [LINUX_A]: { owner: CUSTOMER_A, target: target(LINUX_A, "linux_instance") },
};

function setup(over: Partial<AccessDetailsDeps> = {}) {
  const order: string[] = [];
  const logged: LogEvent[] = [];
  const audits: unknown[] = [];
  const fetched: ReadTarget[] = [];
  const deps: AccessDetailsDeps = {
    loadTarget: async (caller, resourceId) => {
      order.push("load");
      const row = rows[resourceId];
      return row !== undefined && row.owner === caller.customerId ? row.target : null;
    },
    rateLimit: async () => {
      order.push("limit");
      return true;
    },
    windowsPassword: async (t) => {
      order.push("fetch");
      fetched.push(t);
      return { username: "Administrator", password: SECRET };
    },
    databasePassword: async () => {
      throw new Error("not used here");
    },
    bucketKeyCreate: async () => {
      throw new Error("not used here");
    },
    bucketKeyList: async () => {
      throw new Error("not used here");
    },
    claimRequest: async () => true,
    audit: async (entry) => {
      order.push("audit");
      audits.push(entry);
    },
    log: (e) => logged.push(e),
    ...over,
  };
  return { access: createAccessDetails(deps), order, logged, audits, fetched };
}

const A = { customerId: CUSTOMER_A };

describe("windowsPassword", () => {
  it("answers in the order of R9 and returns the secret with no-store", async () => {
    const { access, order, fetched } = setup();
    const r = await access.windowsPassword(WIN_A, A);
    expect(r).toEqual({
      ok: true,
      value: { username: "Administrator", password: SECRET },
      cacheControl: "no-store",
    });
    expect(order).toEqual(["load", "limit", "fetch", "audit"]);
    expect(fetched).toHaveLength(1);
  });

  it("customer B asking for A's server gets the answer of a missing resource, and AWS is not called", async () => {
    const { access, fetched, order } = setup();
    const other = await access.windowsPassword(WIN_A, { customerId: CUSTOMER_B });
    const missing = await access.windowsPassword(GHOST, { customerId: CUSTOMER_B });
    expect(other).toEqual({ ok: false, error: "not_found" });
    expect(other).toEqual(missing);
    expect(fetched).toEqual([]);
    expect(order).not.toContain("fetch");
    expect(order).not.toContain("audit");
  });

  it("refuses an id that is not a platform id, and a caller that is not a customer", async () => {
    const { access, order } = setup();
    expect(await access.windowsPassword("../x", A)).toEqual({ ok: false, error: "not_found" });
    const bad = await access.windowsPassword(WIN_A, { customerId: "" });
    expect(bad).toEqual({ ok: false, error: "unauthenticated" });
    const both = await access.windowsPassword(WIN_A, {
      customerId: CUSTOMER_A,
      adminId: "x",
    } as never);
    expect(both).toEqual({ ok: false, error: "unauthenticated" });
    expect(order).not.toContain("fetch");
  });

  it("answers a Linux instance of the same customer with validation, never asking AWS", async () => {
    const { access, fetched } = setup();
    expect(await access.windowsPassword(LINUX_A, A)).toEqual({ ok: false, error: "validation" });
    expect(fetched).toEqual([]);
  });

  it("is refused by the rate limit before AWS is asked", async () => {
    const { access, fetched, audits } = setup({ rateLimit: async () => false });
    expect(await access.windowsPassword(WIN_A, A)).toEqual({ ok: false, error: "rate_limited" });
    expect(fetched).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("returns no secret when the audit row cannot be written (fail closed, R16)", async () => {
    const { access } = setup({
      audit: async () => {
        throw new Error(`db down ${SECRET}`);
      },
    });
    const r = await access.windowsPassword(WIN_A, A);
    expect(r).toEqual({ ok: false, error: "internal" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("audits with the actor, the target and no secret", async () => {
    const { access, audits } = setup();
    await access.windowsPassword(WIN_A, A);
    expect(audits).toEqual([
      { customerId: CUSTOMER_A, action: "windows_password.reveal", resourceId: WIN_A },
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it("maps AWS errors to platform codes without their text", async () => {
    const cases: [ConstructorParameters<typeof AwsError>[0], string][] = [
      [{ code: "conflict", retryable: false }, "conflict"],
      [{ code: "upstream_unavailable", retryable: false }, "upstream_unavailable"],
      [{ code: "forbidden", retryable: true }, "upstream_unavailable"],
      [{ code: "rate_limited", retryable: true }, "rate_limited"],
      [{ code: "not_found", retryable: false }, "not_found"],
      [{ code: "internal", retryable: false }, "internal"],
    ];
    for (const [awsError, expected] of cases) {
      const { access } = setup({
        windowsPassword: async () => {
          throw new AwsError(awsError);
        },
      });
      const r = await access.windowsPassword(WIN_A, A);
      expect(r).toEqual({ ok: false, error: expected });
    }
    const { access } = setup({
      windowsPassword: async () => {
        throw new Error(`boom ${SECRET} ${POOL_ACCOUNT}`);
      },
    });
    const r = await access.windowsPassword(WIN_A, A);
    expect(r).toEqual({ ok: false, error: "internal" });
  });

  it("logs fixed words only: no password, no ids, no pool account", async () => {
    const { access, logged } = setup();
    await access.windowsPassword(WIN_A, A);
    await access.windowsPassword(WIN_A, { customerId: CUSTOMER_B });
    expect(logged.length).toBeGreaterThan(0);
    const text = JSON.stringify(logged);
    for (const planted of [SECRET, POOL_ACCOUNT, EXTERNAL_ID, WIN_A, CUSTOMER_A, CUSTOMER_B]) {
      expect(text).not.toContain(planted);
    }
    expect(logged[0]).toMatchObject({ event: "access_details", action: "windows_password" });
  });

  it("does not keep the secret: a second call fetches again", async () => {
    const { access, fetched } = setup();
    await access.windowsPassword(WIN_A, A);
    await access.windowsPassword(WIN_A, A);
    expect(fetched).toHaveLength(2);
  });
});
