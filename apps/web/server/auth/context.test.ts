import { describe, expect, it } from "vitest";
import type { WebRuntime } from "../runtime.ts";
import { actionContext } from "./context.ts";

function runtime(fakes: boolean): WebRuntime {
  return {
    config: {
      stage: fakes ? "local" : "staging",
      appOrigin: fakes ? "http://localhost:3000" : "https://cloud.example.com",
      epsMode: "sandbox",
      fakes,
      fake: { eps: false, idp: fakes, sms: false },
    },
    eps: null,
    identity: null,
    otp: null,
    authLimitKey: null,
    kyc: null,
    kycCheck: null,
    account: null,
    totp: null,
    reader: null,
    access: null,
    renderer: null,
  };
}

describe("actionContext: the client address", () => {
  it("takes CloudFront-Viewer-Address, with its port removed", () => {
    const headers = new Headers({ "cloudfront-viewer-address": "198.51.100.7:4711" });
    expect(actionContext(headers, runtime(false)).ip).toBe("198.51.100.7");
  });

  it("ignores a forged x-forwarded-for when the CloudFront header is there", () => {
    const headers = new Headers({
      "cloudfront-viewer-address": "198.51.100.7:4711",
      "x-forwarded-for": "203.0.113.1",
    });
    expect(actionContext(headers, runtime(false)).ip).toBe("198.51.100.7");
  });

  it("has no address from x-forwarded-for alone outside fakes", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.1" });
    expect(actionContext(headers, runtime(false)).ip).toBeNull();
    expect(actionContext(new Headers(), runtime(false)).ip).toBeNull();
  });

  it("refuses a malformed viewer address", () => {
    const headers = new Headers({ "cloudfront-viewer-address": "not-an-address" });
    expect(actionContext(headers, runtime(false)).ip).toBeNull();
  });

  it("fakes give the loopback address when the header is absent", () => {
    expect(actionContext(new Headers(), runtime(true)).ip).toBe("127.0.0.1");
    const forged = new Headers({ "x-forwarded-for": "203.0.113.1" });
    expect(actionContext(forged, runtime(true)).ip).toBe("127.0.0.1");
  });

  it("carries a reference of eight hex characters", () => {
    expect(actionContext(new Headers(), runtime(false)).ref).toMatch(/^[0-9a-f]{8}$/);
  });
});
