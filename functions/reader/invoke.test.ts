import { describe, expect, it } from "vitest";
import { readConfig } from "./config";
import { createInvoke } from "./invoke";
import { CUSTOMER_A, CUSTOMER_B, GHOST, RESOURCE_A, RESOURCE_B, setup } from "./test/kit";

describe("invoke", () => {
  it("routes describe and metrics to the reader", async () => {
    const { reader } = setup();
    const invoke = createInvoke(reader);
    const d = await invoke({
      action: "describe",
      resourceId: RESOURCE_A,
      caller: { customerId: CUSTOMER_A },
    });
    expect(d.ok).toBe(true);
    const m = await invoke({
      action: "metrics",
      resourceId: RESOURCE_A,
      caller: { customerId: CUSTOMER_A },
      range: "1w",
    });
    expect(m.ok).toBe(true);
  });

  it("customer A cannot read customer B's metrics through the invocation either", async () => {
    const { reader, calls } = setup();
    const invoke = createInvoke(reader);
    const foreign = await invoke({
      action: "metrics",
      resourceId: RESOURCE_B,
      caller: { customerId: CUSTOMER_A },
      range: "1h",
    });
    const missing = await invoke({
      action: "metrics",
      resourceId: GHOST,
      caller: { customerId: CUSTOMER_A },
      range: "1h",
    });
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(foreign).toEqual(missing);
    expect(calls).toEqual([]);
  });

  it("ignores every field of the event it does not know: a customer id beside an admin id is refused", async () => {
    const { reader } = setup();
    const invoke = createInvoke(reader);
    const got = await invoke({
      action: "describe",
      resourceId: RESOURCE_B,
      caller: { customerId: CUSTOMER_B, adminId: CUSTOMER_A },
    });
    expect(got).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("fails closed on events that are not well formed, with no lookup", async () => {
    const { reader, loads } = setup();
    const invoke = createInvoke(reader);
    const bad: unknown[] = [
      undefined,
      null,
      "describe",
      {},
      { action: "delete", resourceId: RESOURCE_A, caller: { customerId: CUSTOMER_A } },
      { action: "describe", caller: { customerId: CUSTOMER_A } },
      { action: "describe", resourceId: 5, caller: { customerId: CUSTOMER_A } },
      { action: "metrics", resourceId: RESOURCE_A, caller: { customerId: CUSTOMER_A } },
      { action: "checkDomain", name: "example.com" },
    ];
    for (const event of bad) {
      const got = await invoke(event);
      expect(got.ok).toBe(false);
    }
    expect(loads).toEqual([]);
  });
});

describe("readConfig", () => {
  it("has a default and accepts a bounded rate limit", () => {
    expect(readConfig({})).toEqual({ rateLimit: { max: 120, windowMs: 60_000 } });
    expect(readConfig({ READER_RATE_MAX: "30" })).toEqual({
      rateLimit: { max: 30, windowMs: 60_000 },
    });
  });

  it("refuses a value that is not a small integer, naming the variable and never its value", () => {
    for (const v of ["0", "-1", "1.5", "abc", "10001", " 5"]) {
      expect(() => readConfig({ READER_RATE_MAX: v })).toThrow(
        /^reader: READER_RATE_MAX is missing or invalid$/,
      );
    }
  });
});
