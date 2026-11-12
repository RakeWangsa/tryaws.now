import { describe, expect, it } from "vitest";
import type { AccessDetails } from "./handler";
import { accessTierOf, createInvoke } from "./invoke";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const RES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ARN = "arn:aws:lambda:ap-south-1:123456789012:function:AccessDetails";

function setup() {
  const seen: { action: string; resourceId: string; caller: unknown; requestId?: string }[] = [];
  const refusal = { ok: false, error: "not_found" } as const;
  const access: AccessDetails = {
    windowsPassword: async (resourceId, caller) => {
      seen.push({ action: "windows_password", resourceId, caller });
      return refusal;
    },
    databasePassword: async (resourceId, caller) => {
      seen.push({ action: "database_password", resourceId, caller });
      return refusal;
    },
    bucketKeyCreate: async (resourceId, requestId, caller) => {
      seen.push({ action: "bucket_key_create", resourceId, caller, requestId });
      return refusal;
    },
    bucketKeyList: async (resourceId, caller) => {
      seen.push({ action: "bucket_key_list", resourceId, caller });
      return refusal;
    },
  };
  return { invoke: createInvoke(access), seen };
}

const caller = { customerId: CUSTOMER, extra: "x", password: "p" };

describe("invoke", () => {
  it("passes a checked event of each action with a rebuilt caller, on the web tier", async () => {
    const { invoke, seen } = setup();
    for (const action of ["windows_password", "database_password", "bucket_key_list"]) {
      await invoke({ action, resourceId: RES, caller }, "web");
    }
    await invoke({ action: "bucket_key_create", resourceId: RES, requestId: REQ, caller }, "web");
    expect(seen.map((s) => s.action)).toEqual([
      "windows_password",
      "database_password",
      "bucket_key_list",
      "bucket_key_create",
    ]);
    for (const s of seen) expect(s.caller).toEqual({ customerId: CUSTOMER });
    expect(seen[3]?.requestId).toBe(REQ);
  });

  it("accepts customerId on the web alias only: admin, unknown and missing tiers are refused", async () => {
    const { invoke, seen } = setup();
    for (const action of ["windows_password", "database_password", "bucket_key_list"]) {
      for (const tier of ["admin", null] as const) {
        const r = await invoke({ action, resourceId: RES, caller }, tier);
        expect(r).toEqual({ ok: false, error: "unauthenticated" });
      }
    }
    const r = await invoke(
      { action: "bucket_key_create", resourceId: RES, requestId: REQ, caller },
      "admin",
    );
    expect(r).toEqual({ ok: false, error: "unauthenticated" });
    expect(seen).toEqual([]);
  });

  it("refuses anything that is not that shape before the handler runs", async () => {
    const { invoke, seen } = setup();
    for (const event of [
      null,
      "x",
      {},
      { action: "other", resourceId: RES, caller: { customerId: CUSTOMER } },
      { action: "windows_password", resourceId: 7, caller: { customerId: CUSTOMER } },
      { action: "windows_password", resourceId: RES },
      { action: "windows_password", resourceId: RES, caller: { adminId: CUSTOMER } },
      {
        action: "database_password",
        resourceId: RES,
        caller: { customerId: CUSTOMER, adminId: "a" },
      },
      { action: "windows_password", resourceId: RES, caller: { customerId: 5 } },
      { action: "bucket_key_create", resourceId: RES, caller: { customerId: CUSTOMER } },
      {
        action: "bucket_key_create",
        resourceId: RES,
        requestId: 3,
        caller: { customerId: CUSTOMER },
      },
    ]) {
      const r = await invoke(event, "web");
      expect(r.ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });
});

describe("accessTierOf", () => {
  it("takes the tier from the alias of the invoked ARN, exactly", () => {
    expect(accessTierOf(`${ARN}:web`)).toBe("web");
    expect(accessTierOf(`${ARN}:admin`)).toBe("admin");
    for (const bad of [ARN, `${ARN}:$LATEST`, `${ARN}:3`, `${ARN}:web:x`, "web", 5, undefined]) {
      expect(accessTierOf(bad)).toBeNull();
    }
  });
});
