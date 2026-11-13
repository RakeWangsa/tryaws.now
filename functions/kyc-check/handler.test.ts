import { kycObjectKey } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createKycCheckHandler, kycCheckTierOf, type HeadResult } from "./handler";

const CUSTOMER_A = "0192f3a0-0000-7000-8000-00000000000a";
const CUSTOMER_B = "0192f3a0-0000-7000-8000-00000000000b";
const SUBMISSION = "0192f3a0-0000-7000-8000-000000000101";
const KEY_A = kycObjectKey(CUSTOMER_A, SUBMISSION, 0, "image/png");
const KEY_B = kycObjectKey(CUSTOMER_B, SUBMISSION, 0, "image/png");
const FN = "arn:aws:lambda:ap-southeast-1:111122223333:function:tc-stage-kyc-check";

function setup(answer: (key: string) => Promise<HeadResult> = async () => ({ present: false })) {
  const heads: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const handler = createKycCheckHandler({
    head: (key) => {
      heads.push(key);
      return answer(key);
    },
    log: (e) => logs.push(e),
  });
  return { handler, heads, logs };
}

const event = (key: string, caller: unknown = { customerId: CUSTOMER_A }) => ({
  action: "head",
  key,
  caller,
});

describe("tier of the invocation", () => {
  it("is web only on the alias web; everything else is no tier", () => {
    expect(kycCheckTierOf(`${FN}:web`)).toBe("web");
    for (const arn of [FN, `${FN}:admin`, `${FN}:$LATEST`, `${FN}:1`, `${FN}:WEB`, "", 5, null]) {
      expect(kycCheckTierOf(arn)).toBeNull();
    }
  });

  it("refuses an invocation of no tier before it reads the event (R16)", async () => {
    const { handler, heads } = setup();
    expect(await handler(event(KEY_A), null)).toEqual({ ok: false, error: "unauthenticated" });
    expect(heads).toEqual([]);
  });
});

describe("kyc-check", () => {
  it("answers size and type of the customer's own object, and nothing else", async () => {
    const { handler, heads } = setup(async () => ({
      present: true,
      size: 1234,
      contentType: "image/png",
    }));
    expect(await handler(event(KEY_A), "web")).toEqual({
      ok: true,
      value: { present: true, size: 1234, contentType: "image/png" },
    });
    expect(heads).toEqual([KEY_A]);
  });

  it("answers present false with no size and no type when the object is missing", async () => {
    const { handler } = setup();
    expect(await handler(event(KEY_A), "web")).toEqual({
      ok: true,
      value: { present: false, size: null, contentType: null },
    });
  });

  it("customer A cannot ask about customer B's object: refused before S3 is asked (R8)", async () => {
    const { handler, heads, logs } = setup(async () => ({
      present: true,
      size: 5,
      contentType: "image/png",
    }));
    expect(await handler(event(KEY_B), "web")).toEqual({ ok: false, error: "forbidden" });
    expect(heads).toEqual([]);
    expect(logs).toEqual([{ event: "kyc_check", outcome: "forbidden" }]);
  });

  it("refuses a caller that is not exactly one customer id", async () => {
    const { handler, heads } = setup();
    for (const caller of [
      undefined,
      null,
      {},
      { adminId: CUSTOMER_A },
      { customerId: CUSTOMER_A, adminId: CUSTOMER_B },
      { customerId: "" },
      { customerId: 5 },
    ]) {
      expect(await handler({ action: "head", key: KEY_A, caller }, "web")).toEqual({
        ok: false,
        error: "unauthenticated",
      });
    }
    expect(heads).toEqual([]);
  });

  it("refuses events that are not well formed and keys that are not KYC keys", async () => {
    const { handler, heads } = setup();
    for (const bad of [
      undefined,
      null,
      "head",
      {},
      { action: "get", key: KEY_A, caller: { customerId: CUSTOMER_A } },
      { action: "head", caller: { customerId: CUSTOMER_A } },
      event("invoices/x.pdf"),
      event(`${KEY_A}/../other`),
    ]) {
      const got = await handler(bad, "web");
      expect(got.ok).toBe(false);
    }
    expect(heads).toEqual([]);
  });

  it("turns any failure of S3 into upstream_unavailable with no AWS text (R14, R16)", async () => {
    const { handler, logs } = setup(async () => {
      throw new Error("AccessDenied arn:aws:iam::111122223333:role/x");
    });
    const got = await handler(event(KEY_A), "web");
    expect(got).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(logs)).not.toMatch(/arn:|111122223333|AccessDenied/);
  });

  it("fails closed on an answer of S3 it cannot trust", async () => {
    for (const answer of [
      { present: true, size: -1, contentType: "image/png" },
      { present: true, size: 1.5, contentType: "image/png" },
      { present: true, size: Number.NaN, contentType: "image/png" },
      { present: true, size: 1, contentType: 5 },
      { present: true, size: 1, contentType: "x".repeat(300) },
    ]) {
      const { handler } = setup(async () => answer as HeadResult);
      expect(await handler(event(KEY_A), "web")).toEqual({
        ok: false,
        error: "upstream_unavailable",
      });
    }
  });

  it("logs fixed words only: no key, no customer id", async () => {
    const { handler, logs } = setup(async () => ({
      present: true,
      size: 1,
      contentType: "image/png",
    }));
    await handler(event(KEY_A), "web");
    expect(logs).toEqual([{ event: "kyc_check", outcome: "present" }]);
    expect(JSON.stringify(logs)).not.toContain(CUSTOMER_A);
  });
});
