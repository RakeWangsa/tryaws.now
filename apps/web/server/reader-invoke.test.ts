import { describe, expect, it, vi } from "vitest";
import {
  READER_FUNCTION_PATTERN,
  readerPortFromEnv,
  readerPortFromInvoker,
  type ReaderInvoker,
} from "./reader-invoke.ts";

// WPU-G4: the invoke port of the `reader` function. R1: this file holds no provisioning call; R16:
// anything unclear is "not available"; R14/U6: no text of a failure leaves the port.

const ID = "0190aaaa-0000-7000-8000-000000000001";
const CUSTOMER = "0190aaaa-0000-7000-8000-0000000000c1";

const good = {
  ok: true,
  value: {
    resourceId: ID,
    range: "1h",
    series: [
      {
        metric: "cpu",
        unit: "percent",
        points: [
          { at: "2026-11-12T01:00:00.000Z", value: 12 },
          { at: "2026-11-12T01:05:00.000Z", value: 40 },
        ],
      },
    ],
  },
};

const answering = (body: unknown, functionError = false): ReaderInvoker => ({
  invoke: vi.fn(async () => ({ functionError, payload: JSON.stringify(body) })),
});

describe("readerPortFromInvoker", () => {
  it("sends the action, the resource, the session's customer and the range, and nothing else", async () => {
    const invoker = answering(good);
    const port = readerPortFromInvoker(invoker);
    const out = await port.metrics(ID, { customerId: CUSTOMER }, "1h");
    expect(out.ok).toBe(true);
    const sent = JSON.parse((invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(sent).toEqual({
      action: "metrics",
      resourceId: ID,
      caller: { customerId: CUSTOMER },
      range: "1h",
    });
  });

  it("returns the series the reader answered", async () => {
    const out = await readerPortFromInvoker(answering(good)).metrics(
      ID,
      { customerId: CUSTOMER },
      "1h",
    );
    expect(out).toEqual({
      ok: true,
      series: [
        {
          metric: "cpu",
          unit: "percent",
          points: [
            { at: "2026-11-12T01:00:00.000Z", value: 12 },
            { at: "2026-11-12T01:05:00.000Z", value: 40 },
          ],
        },
      ],
    });
  });

  it("maps a refusal of the reader to a fixed code and keeps no text of it", async () => {
    const out = await readerPortFromInvoker(answering({ ok: false, error: "not_found" })).metrics(
      ID,
      { customerId: CUSTOMER },
      "1h",
    );
    expect(out).toEqual({ ok: false, error: "not_found" });
    const odd = await readerPortFromInvoker(
      answering({ ok: false, error: "arn:aws:iam::123456789012:role/x" }),
    ).metrics(ID, { customerId: CUSTOMER }, "1h");
    expect(odd).toEqual({ ok: false, error: "unavailable" });
  });

  it("fails closed on a function error, a payload that is not JSON and a payload of the wrong shape", async () => {
    const port = (invoker: ReaderInvoker) => readerPortFromInvoker(invoker);
    const run = (invoker: ReaderInvoker) =>
      port(invoker).metrics(ID, { customerId: CUSTOMER }, "1h");
    const unavailable = { ok: false, error: "unavailable" };
    expect(await run(answering({ errorMessage: "boom arn:aws:x" }, true))).toEqual(unavailable);
    expect(
      await run({ invoke: async () => ({ functionError: false, payload: "not json" }) }),
    ).toEqual(unavailable);
    expect(await run(answering({ ok: true, value: { series: "no" } }))).toEqual(unavailable);
    expect(await run(answering({ ok: true }))).toEqual(unavailable);
    expect(await run(answering(null))).toEqual(unavailable);
  });

  it("refuses a series with a metric, a unit or a value it does not know", async () => {
    const bad = (series: unknown) =>
      readerPortFromInvoker(answering({ ok: true, value: { series } })).metrics(
        ID,
        { customerId: CUSTOMER },
        "1h",
      );
    const unavailable = { ok: false, error: "unavailable" };
    expect(await bad([{ metric: "disk", unit: "percent", points: [] }])).toEqual(unavailable);
    expect(await bad([{ metric: "cpu", unit: "furlongs", points: [] }])).toEqual(unavailable);
    expect(
      await bad([
        { metric: "cpu", unit: "percent", points: [{ at: "2026-11-12T01:00:00Z", value: "9" }] },
      ]),
    ).toEqual(unavailable);
    expect(
      await bad([{ metric: "cpu", unit: "percent", points: [{ at: "yesterday", value: 9 }] }]),
    ).toEqual(unavailable);
  });

  it("never throws: a failed or hung call is unavailable", async () => {
    const throwing: ReaderInvoker = {
      invoke: async () => {
        throw new Error("connect ECONNREFUSED arn:aws:lambda:ap-south-1:123456789012:function:x");
      },
    };
    const out = await readerPortFromInvoker(throwing).metrics(ID, { customerId: CUSTOMER }, "1h");
    expect(out).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(out)).not.toMatch(/arn|ECONN|123456789012/);
  });

  it("refuses an id that is not a UUID before anything is sent (R16)", async () => {
    const invoker = answering(good);
    const out = await readerPortFromInvoker(invoker).metrics(
      "../etc",
      { customerId: CUSTOMER },
      "1h",
    );
    expect(out).toEqual({ ok: false, error: "validation" });
    expect(invoker.invoke).not.toHaveBeenCalled();
  });
});

describe("readerPortFromEnv", () => {
  it("is null without a function name, and null for a name that is not a function name", () => {
    expect(readerPortFromEnv({})).toBeNull();
    expect(readerPortFromEnv({ READER_FUNCTION_NAME: "" })).toBeNull();
    expect(readerPortFromEnv({ READER_FUNCTION_NAME: "a b" })).toBeNull();
    expect(readerPortFromEnv({ READER_FUNCTION_NAME: "x".repeat(200) })).toBeNull();
  });

  it("builds the client on the first call, never at import, with the region of the environment", async () => {
    const build = vi.fn((_region: string, _name: string) => answering(good));
    const port = readerPortFromEnv(
      { READER_FUNCTION_NAME: "tc-staging-reader", AWS_REGION: "ap-south-1" },
      build,
    );
    expect(port).not.toBeNull();
    expect(build).not.toHaveBeenCalled();
    await port!.metrics(ID, { customerId: CUSTOMER }, "1d");
    await port!.metrics(ID, { customerId: CUSTOMER }, "1d");
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("ap-south-1", "tc-staging-reader");
  });

  it("accepts a function name and not a full ARN or a path", () => {
    expect(READER_FUNCTION_PATTERN.test("tc-staging-reader")).toBe(true);
    expect(READER_FUNCTION_PATTERN.test("arn:aws:lambda:ap-south-1:123456789012:function:x")).toBe(
      false,
    );
    expect(READER_FUNCTION_PATTERN.test("../x")).toBe(false);
  });
});
