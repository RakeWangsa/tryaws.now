import { describe, expect, it } from "vitest";
import type { AccessDetails } from "./handler";
import { createInvoke } from "./invoke";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const RES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup() {
  const seen: { resourceId: string; caller: unknown }[] = [];
  const access: AccessDetails = {
    windowsPassword: async (resourceId, caller) => {
      seen.push({ resourceId, caller });
      return { ok: false, error: "not_found" };
    },
  };
  return { invoke: createInvoke(access), seen };
}

describe("invoke", () => {
  it("passes a checked windows_password event with a rebuilt caller", async () => {
    const { invoke, seen } = setup();
    await invoke({
      action: "windows_password",
      resourceId: RES,
      caller: { customerId: CUSTOMER, extra: "x", password: "p" },
    });
    expect(seen).toEqual([{ resourceId: RES, caller: { customerId: CUSTOMER } }]);
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
      { action: "windows_password", resourceId: RES, caller: { customerId: 5 } },
    ]) {
      const r = await invoke(event);
      expect(r.ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });
});
