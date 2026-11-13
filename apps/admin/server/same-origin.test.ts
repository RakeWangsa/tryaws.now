import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./same-origin.ts";

const ENV = { APP_ORIGIN: "https://admin.tryaws.now" };
const h = (init: Record<string, string>) => new Headers(init);

describe("isSameOriginRequest", () => {
  it("accepts a request the browser marks same-origin", () => {
    expect(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }), ENV)).toBe(true);
  });

  it.each(["cross-site", "same-site", "none"])("refuses Sec-Fetch-Site %s", (site) => {
    expect(isSameOriginRequest(h({ "sec-fetch-site": site }), ENV)).toBe(false);
  });

  it("Sec-Fetch-Site decides even when Origin or Referer look right", () => {
    const headers = h({
      "sec-fetch-site": "cross-site",
      origin: "https://admin.tryaws.now",
      referer: "https://admin.tryaws.now/audit",
    });
    expect(isSameOriginRequest(headers, ENV)).toBe(false);
  });

  it("without Sec-Fetch-Site it compares Origin with APP_ORIGIN", () => {
    expect(isSameOriginRequest(h({ origin: "https://admin.tryaws.now" }), ENV)).toBe(true);
    expect(isSameOriginRequest(h({ origin: "https://evil.example" }), ENV)).toBe(false);
    expect(isSameOriginRequest(h({ origin: "null" }), ENV)).toBe(false);
  });

  it("without Sec-Fetch-Site and Origin it compares the origin of Referer", () => {
    expect(isSameOriginRequest(h({ referer: "https://admin.tryaws.now/en/audit?x=1" }), ENV)).toBe(
      true,
    );
    expect(isSameOriginRequest(h({ referer: "https://admin.tryaws.now.evil.example/" }), ENV)).toBe(
      false,
    );
    expect(isSameOriginRequest(h({ referer: "not a url" }), ENV)).toBe(false);
  });

  it("refuses a request with no evidence at all (R16)", () => {
    expect(isSameOriginRequest(h({}), ENV)).toBe(false);
  });

  it("refuses when APP_ORIGIN is missing or malformed and there is nothing but Origin to compare", () => {
    expect(isSameOriginRequest(h({ origin: "https://admin.tryaws.now" }), {})).toBe(false);
    expect(
      isSameOriginRequest(h({ origin: "https://admin.tryaws.now" }), { APP_ORIGIN: "nonsense" }),
    ).toBe(false);
  });
});
