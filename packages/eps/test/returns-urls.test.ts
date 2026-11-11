import { describe, expect, it } from "vitest";
import { EPS_RETURN_PATHS, epsReturnUrls } from "../returns";

describe("epsReturnUrls", () => {
  it("builds the three fixed paths on an https base", () => {
    expect(EPS_RETURN_PATHS).toEqual({
      success: "/pay/eps/success",
      fail: "/pay/eps/fail",
      cancel: "/pay/eps/cancel",
    });
    expect(epsReturnUrls("https://cloud.example.test")).toEqual({
      successUrl: "https://cloud.example.test/pay/eps/success",
      failUrl: "https://cloud.example.test/pay/eps/fail",
      cancelUrl: "https://cloud.example.test/pay/eps/cancel",
    });
    expect(epsReturnUrls("https://cloud.example.test/").successUrl).toBe(
      "https://cloud.example.test/pay/eps/success",
    );
  });

  it.each([
    "http://cloud.example.test",
    "ftp://cloud.example.test",
    "cloud.example.test",
    "https://user:pw@cloud.example.test",
    "https://cloud.example.test/x",
    "https://cloud.example.test/?a=1",
    "https://cloud.example.test/#f",
    "",
  ])("refuses the base %j", (base) => {
    expect(() => epsReturnUrls(base)).toThrow(TypeError);
  });

  it("refuses a base that is not text", () => {
    expect(() => epsReturnUrls(undefined as unknown as string)).toThrow(TypeError);
  });
});
