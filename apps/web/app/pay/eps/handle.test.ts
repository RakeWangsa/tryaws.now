import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebConfig } from "../../../server/config.ts";

const state = vi.hoisted(() => ({
  runtime: null as unknown,
  runtimeError: false,
  session: { ok: false, error: "unauthenticated" } as unknown,
  handleReturn: vi.fn(),
}));

vi.mock("../../../server/runtime.ts", () => ({
  getRuntime: async () => {
    if (state.runtimeError) throw new Error("runtime down");
    return state.runtime;
  },
}));
vi.mock("@tc/auth", () => ({ currentCustomer: async () => state.session }));

import { handleHeadRequest, handleReturnRequest } from "./handle.ts";

const prod: WebConfig = {
  stage: "production",
  appOrigin: "https://cloud.example.com",
  epsMode: "production",
  fakes: false,
  fake: { eps: false, idp: false, sms: false },
};
const fake: WebConfig = {
  stage: "local",
  appOrigin: "http://localhost:3000",
  epsMode: "sandbox",
  fakes: true,
  fake: { eps: true, idp: false, sms: false },
};
const ID = "0123456789abcdef0123456789abcdef";
const VIEWER = { "cloudfront-viewer-address": "203.0.113.9:44321" };

function use(config: WebConfig, eps: unknown = { handleReturn: state.handleReturn }) {
  state.runtime = { config, eps };
}
function credited() {
  state.handleReturn.mockResolvedValue({ redirectTo: "/wallet?topup=credited", state: "credited" });
}
function get(path: string, headers: Record<string, string> = VIEWER) {
  return new Request(`https://cloud.example.com${path}`, { headers });
}

beforeEach(() => {
  state.runtimeError = false;
  state.session = { ok: false, error: "unauthenticated" };
  state.handleReturn.mockReset();
  use(prod);
});
afterEach(() => vi.restoreAllMocks());

describe("handleReturnRequest: what it asks of the package", () => {
  it("calls handleReturn once with the outcome, the id and the address of the viewer", async () => {
    credited();
    const response = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(state.handleReturn).toHaveBeenCalledTimes(1);
    expect(state.handleReturn).toHaveBeenCalledWith({
      outcome: "success",
      query: { MerchantTransactionId: ID },
      clientIp: "203.0.113.9",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=credited",
    );
  });

  it("passes the name of the route as the outcome, and nothing else decides", async () => {
    state.handleReturn.mockResolvedValue({ redirectTo: "/wallet?topup=failed", state: "failed" });
    for (const outcome of ["success", "fail", "cancel"] as const) {
      state.handleReturn.mockClear();
      await handleReturnRequest(get(`/pay/eps/${outcome}?MerchantTransactionId=${ID}`), outcome);
      expect(state.handleReturn.mock.calls[0]?.[0].outcome).toBe(outcome);
    }
  });

  it("a repeated key becomes an array, and the package decides what two ids mean", async () => {
    state.handleReturn.mockResolvedValue({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    const other = "fedcba9876543210fedcba9876543210";
    const response = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}&MerchantTransactionId=${other}`),
      "success",
    );
    expect(state.handleReturn.mock.calls[0]?.[0].query).toEqual({
      MerchantTransactionId: [ID, other],
    });
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=unknown",
    );
  });

  it("a key named __proto__ is data, not a prototype", async () => {
    state.handleReturn.mockResolvedValue({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    await handleReturnRequest(
      get(`/pay/eps/success?__proto__=x&constructor=y&MerchantTransactionId=${ID}`),
      "success",
    );
    const query = state.handleReturn.mock.calls[0]?.[0].query as Record<string, unknown>;
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.hasOwn(query, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("the same request twice calls the package twice and both answer without a cookie", async () => {
    credited();
    const request = () => get(`/pay/eps/success?MerchantTransactionId=${ID}`);
    const first = await handleReturnRequest(request(), "success");
    const second = await handleReturnRequest(request(), "success");
    expect(state.handleReturn).toHaveBeenCalledTimes(2);
    for (const response of [first, second]) {
      expect(response.status).toBe(303);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
  });

  it("a package that throws gives pending, never a success", async () => {
    state.handleReturn.mockRejectedValue(new Error("boom"));
    const response = await handleReturnRequest(get("/pay/eps/success"), "success");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=pending",
    );
  });
});

describe("handleReturnRequest: where it sends the customer", () => {
  it("an English session goes to /en/wallet, a session of Bengali or none too (WPU-X19: English only)", async () => {
    credited();
    state.session = { ok: true, value: { locale: "en", customerId: "c1" } };
    const en = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(en.headers.get("location")).toBe("https://cloud.example.com/en/wallet?topup=credited");
    state.session = { ok: true, value: { locale: "bn", customerId: "c1" } };
    const bn = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(bn.headers.get("location")).toBe("https://cloud.example.com/en/wallet?topup=credited");
    state.session = { ok: false, error: "unauthenticated" };
    const none = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(none.headers.get("location")).toBe("https://cloud.example.com/en/wallet?topup=credited");
  });

  it("a hostile query never changes the Location", async () => {
    credited();
    const response = await handleReturnRequest(
      get(
        `/pay/eps/success?next=https://evil.com&redirect=//evil.com&url=javascript:x&status=Success&returnTo=%2F%2Fevil.com&MerchantTransactionId=${ID}`,
      ),
      "success",
    );
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=credited",
    );
  });

  it("a request for another Host still redirects to the configured origin", async () => {
    credited();
    const request = new Request(`https://evil.com/pay/eps/success?MerchantTransactionId=${ID}`, {
      headers: { ...VIEWER, host: "evil.com", "x-forwarded-host": "evil.com" },
    });
    const response = await handleReturnRequest(request, "success");
    expect(new URL(response.headers.get("location") ?? "").origin).toBe(
      "https://cloud.example.com",
    );
  });

  it("a package answer that is not one of ours is replaced by unknown", async () => {
    for (const redirectTo of [
      "https://evil.com/",
      "//evil.com",
      "/wallet?topup=credited&x=1",
      "/dashboard",
      "/wallet?topup=<script>",
      42,
      undefined,
    ]) {
      state.handleReturn.mockResolvedValue({ redirectTo, state: "credited" });
      const response = await handleReturnRequest(
        get(`/pay/eps/success?MerchantTransactionId=${ID}`),
        "success",
      );
      expect(response.headers.get("location"), String(redirectTo)).toBe(
        "https://cloud.example.com/en/wallet?topup=unknown",
      );
    }
  });

  it("accepts each of the six fixed targets of the package", async () => {
    for (const name of ["credited", "pending", "failed", "cancelled", "expired", "unknown"]) {
      state.handleReturn.mockResolvedValue({ redirectTo: `/wallet?topup=${name}`, state: name });
      const response = await handleReturnRequest(
        get(`/pay/eps/success?MerchantTransactionId=${ID}`),
        "success",
      );
      expect(response.headers.get("location")).toBe(
        `https://cloud.example.com/en/wallet?topup=${name}`,
      );
    }
  });
});

describe("handleReturnRequest: fail closed (R16)", () => {
  it("no EPS configured redirects to unknown without a call", async () => {
    use(prod, null);
    const response = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=unknown",
    );
    expect(state.handleReturn).not.toHaveBeenCalled();
  });

  it("no client address redirects to pending without a call; the header x-forwarded-for does not help", async () => {
    const response = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`, { "x-forwarded-for": "198.51.100.1" }),
      "success",
    );
    expect(response.headers.get("location")).toBe(
      "https://cloud.example.com/en/wallet?topup=pending",
    );
    expect(state.handleReturn).not.toHaveBeenCalled();
  });

  it("in fake mode the address is 127.0.0.1", async () => {
    use(fake);
    credited();
    const response = await handleReturnRequest(
      new Request(`http://localhost:3000/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(state.handleReturn.mock.calls[0]?.[0].clientIp).toBe("127.0.0.1");
    expect(response.headers.get("location")).toBe("http://localhost:3000/en/wallet?topup=credited");
  });

  it("a runtime that cannot be built answers 503 with no Location", async () => {
    state.runtimeError = true;
    const response = await handleReturnRequest(get("/pay/eps/success"), "success");
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.handleReturn).not.toHaveBeenCalled();
  });
});

describe("handleReturnRequest: the response", () => {
  const expected = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
    "x-content-type-options": "nosniff",
  };

  it("is a 303 with the four headers and no cookie", async () => {
    credited();
    const response = await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}`),
      "success",
    );
    expect(response.status).toBe(303);
    for (const [name, value] of Object.entries(expected)) {
      expect(response.headers.get(name), name).toBe(value);
    }
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe("");
  });

  it("every answer carries the four headers, also the fail-closed ones", async () => {
    use(prod, null);
    const closed = await handleReturnRequest(get("/pay/eps/fail"), "fail");
    state.runtimeError = true;
    const broken = await handleReturnRequest(get("/pay/eps/fail"), "fail");
    for (const response of [closed, broken]) {
      for (const [name, value] of Object.entries(expected)) {
        expect(response.headers.get(name), name).toBe(value);
      }
    }
  });

  it("no query value reaches a log line", async () => {
    credited();
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}&secret=hunter2`),
      "success",
    );
    state.runtimeError = true;
    await handleReturnRequest(
      get(`/pay/eps/success?MerchantTransactionId=${ID}&secret=hunter2`),
      "success",
    );
    const written = spies.flatMap((spy) => spy.mock.calls.flat()).join("\n");
    expect(written).not.toContain(ID);
    expect(written).not.toContain("hunter2");
  });
});

describe("handleHeadRequest", () => {
  it("answers 405 with Allow: GET and calls nothing (Next would otherwise run GET for a HEAD)", async () => {
    const response = handleHeadRequest();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.handleReturn).not.toHaveBeenCalled();
  });
});
