import { kycObjectKey } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  KYC_CHECK_WEB_ALIAS,
  kycCheckPortFromEnv,
  kycCheckPortFromInvoker,
  type KycCheckInvoker,
} from "./kyc-check-invoke.ts";

const CUSTOMER = "0190a000-0000-7000-8000-000000000001";
const OTHER = "0190a000-0000-7000-8000-000000000009";
const SUBMISSION = "0190a000-0000-7000-8000-000000000002";
const KEY = kycObjectKey(CUSTOMER, SUBMISSION, 0, "image/jpeg");

function invoker(reply: { functionError?: boolean; payload: string } | Error) {
  const sent: string[] = [];
  const inv: KycCheckInvoker = {
    async invoke(payload) {
      sent.push(payload);
      if (reply instanceof Error) throw reply;
      return { functionError: reply.functionError ?? false, payload: reply.payload };
    },
  };
  return { inv, sent };
}

const answer = (value: unknown) => ({ payload: JSON.stringify({ ok: true, value }) });

describe("kyc-check invoke port (WPU-Y3)", () => {
  it("sends the action, the key and the session's customer, and returns size and type", async () => {
    const { inv, sent } = invoker(answer({ present: true, size: 2048, contentType: "image/jpeg" }));
    const got = await kycCheckPortFromInvoker(inv).check(CUSTOMER, KEY);
    expect(got).toEqual({ present: true, size: 2048, contentType: "image/jpeg" });
    expect(JSON.parse(sent[0] ?? "")).toEqual({
      action: "head",
      key: KEY,
      caller: { customerId: CUSTOMER },
    });
  });

  it("returns present false for a missing object", async () => {
    const { inv } = invoker(answer({ present: false, size: null, contentType: null }));
    expect(await kycCheckPortFromInvoker(inv).check(CUSTOMER, KEY)).toEqual({ present: false });
  });

  it("refuses a key that is not the customer's own before it invokes (R8)", async () => {
    const { inv, sent } = invoker(answer({ present: false, size: null, contentType: null }));
    const port = kycCheckPortFromInvoker(inv);
    await expect(port.check(OTHER, KEY)).rejects.toThrow();
    await expect(port.check(CUSTOMER, "kyc/../x")).rejects.toThrow();
    await expect(port.check("not-a-uuid", KEY)).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("throws a fixed message on every failure and on every other shape, with no AWS text (R14, R16)", async () => {
    const replies: Parameters<typeof invoker>[0][] = [
      new Error("arn:aws:lambda:ap-southeast-1:123456789012:function:x"),
      { functionError: true, payload: '{"errorMessage":"arn:aws"}' },
      { payload: "not json" },
      { payload: JSON.stringify({ ok: false, error: "forbidden" }) },
      { payload: JSON.stringify({ ok: false, error: "upstream_unavailable" }) },
      answer({ present: true, size: -1, contentType: "image/jpeg" }),
      answer({ present: true, size: 1.5, contentType: "image/jpeg" }),
      answer({ present: true, size: 1, contentType: 5 }),
      answer({ present: true, size: 1 }),
      answer({ present: "yes", size: 1, contentType: "image/jpeg" }),
      answer({ present: false, size: 5, contentType: null }),
      answer({ present: true, size: 1, contentType: "image/jpeg", body: "AAAA" }),
    ];
    for (const reply of replies) {
      const err = await kycCheckPortFromInvoker(invoker(reply).inv)
        .check(CUSTOMER, KEY)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("kyc-check: the upload could not be checked");
    }
  });

  it("is null without a usable function name, and builds the client lazily", async () => {
    expect(kycCheckPortFromEnv({})).toBeNull();
    expect(
      kycCheckPortFromEnv({ KYC_CHECK_FUNCTION_NAME: "arn:aws:lambda:x:1:function:y" }),
    ).toBeNull();
    const built: string[] = [];
    const port = kycCheckPortFromEnv(
      { KYC_CHECK_FUNCTION_NAME: "tc-staging-kyc-check", AWS_REGION: "ap-southeast-1" },
      (region, name) => {
        built.push(`${region}/${name}`);
        return invoker(answer({ present: false, size: null, contentType: null })).inv;
      },
    );
    expect(port).not.toBeNull();
    expect(built).toHaveLength(0);
    await port?.check(CUSTOMER, KEY);
    await port?.check(CUSTOMER, KEY);
    expect(built).toEqual(["ap-southeast-1/tc-staging-kyc-check"]);
  });

  it("invokes the web alias only", () => {
    expect(KYC_CHECK_WEB_ALIAS).toBe("web");
  });
});
