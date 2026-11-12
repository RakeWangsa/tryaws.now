import { describe, expect, it } from "vitest";
import { readConfig } from "./config";
import { createInvoke, readerTierOf } from "./invoke";
import { ADMIN, CUSTOMER_A, CUSTOMER_B, GHOST, RESOURCE_A, RESOURCE_B, setup } from "./test/kit";

describe("invoke", () => {
  it("routes describe and metrics to the reader", async () => {
    const { reader } = setup();
    const invoke = createInvoke(reader);
    const d = await invoke(
      {
        action: "describe",
        resourceId: RESOURCE_A,
        caller: { customerId: CUSTOMER_A },
      },
      "web",
    );
    expect(d.ok).toBe(true);
    const m = await invoke(
      {
        action: "metrics",
        resourceId: RESOURCE_A,
        caller: { customerId: CUSTOMER_A },
        range: "1w",
      },
      "web",
    );
    expect(m.ok).toBe(true);
  });

  it("customer A cannot read customer B's metrics through the invocation either", async () => {
    const { reader, calls } = setup();
    const invoke = createInvoke(reader);
    const foreign = await invoke(
      {
        action: "metrics",
        resourceId: RESOURCE_B,
        caller: { customerId: CUSTOMER_A },
        range: "1h",
      },
      "web",
    );
    const missing = await invoke(
      {
        action: "metrics",
        resourceId: GHOST,
        caller: { customerId: CUSTOMER_A },
        range: "1h",
      },
      "web",
    );
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(foreign).toEqual(missing);
    expect(calls).toEqual([]);
  });

  it("ignores every field of the event it does not know: a customer id beside an admin id is refused", async () => {
    const { reader } = setup();
    const invoke = createInvoke(reader);
    const got = await invoke(
      {
        action: "describe",
        resourceId: RESOURCE_B,
        caller: { customerId: CUSTOMER_B, adminId: CUSTOMER_A },
      },
      "web",
    );
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
      const got = await invoke(event, "web");
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

describe("tier of the invocation (WPU-S6)", () => {
  const FN = "arn:aws:lambda:ap-south-1:111122223333:function:tc-stage-reader";

  it("reads the tier from the alias of the invoked ARN and refuses everything else", () => {
    expect(readerTierOf(`${FN}:web`)).toBe("web");
    expect(readerTierOf(`${FN}:admin`)).toBe("admin");
    for (const arn of [
      FN,
      `${FN}:$LATEST`,
      `${FN}:1`,
      `${FN}:WEB`,
      `${FN}:web:x`,
      "",
      undefined,
      5,
    ]) {
      expect(readerTierOf(arn)).toBeNull();
    }
  });

  it("refuses an adminId from the web tier with a fixed error and no lookup", async () => {
    const { reader, loads, calls } = setup();
    const invoke = createInvoke(reader);
    const got = await invoke(
      { action: "describe", resourceId: RESOURCE_A, caller: { adminId: ADMIN } },
      "web",
    );
    expect(got).toEqual({ ok: false, error: "unauthenticated" });
    expect(loads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a customerId from the admin tier", async () => {
    const { reader, loads } = setup();
    const invoke = createInvoke(reader);
    const got = await invoke(
      { action: "describe", resourceId: RESOURCE_A, caller: { customerId: CUSTOMER_A } },
      "admin",
    );
    expect(got).toEqual({ ok: false, error: "unauthenticated" });
    expect(loads).toEqual([]);
  });

  it("refuses when the tier is unknown (fail closed, R16)", async () => {
    const { reader, loads } = setup();
    const invoke = createInvoke(reader);
    for (const tier of [null, undefined, "other"]) {
      const got = await invoke(
        { action: "describe", resourceId: RESOURCE_A, caller: { customerId: CUSTOMER_A } },
        tier as never,
      );
      expect(got).toEqual({ ok: false, error: "unauthenticated" });
    }
    expect(loads).toEqual([]);
  });

  it("lets the web tier read its own resource and keeps R8 across customers", async () => {
    const { reader, calls } = setup();
    const invoke = createInvoke(reader);
    const own = await invoke(
      { action: "describe", resourceId: RESOURCE_A, caller: { customerId: CUSTOMER_A } },
      "web",
    );
    expect(own.ok).toBe(true);
    const callsBefore = calls.length;
    const foreign = await invoke(
      { action: "describe", resourceId: RESOURCE_B, caller: { customerId: CUSTOMER_A } },
      "web",
    );
    const missing = await invoke(
      { action: "describe", resourceId: GHOST, caller: { customerId: CUSTOMER_A } },
      "web",
    );
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(foreign).toEqual(missing);
    expect(calls.length).toBe(callsBefore);
  });

  it("passes an admin caller from the admin tier on to the reader", async () => {
    const { reader, loads } = setup();
    const invoke = createInvoke(reader);
    await invoke(
      { action: "describe", resourceId: RESOURCE_A, caller: { adminId: ADMIN } },
      "admin",
    );
    expect(loads.length).toBe(1);
  });
});
