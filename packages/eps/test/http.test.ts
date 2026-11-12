import { describe, expect, it } from "vitest";
import type { Clock } from "@tc/core";
import { epsCredentials } from "../gateway";
import type { InitializeRequest } from "../gateway";
import { epsHash } from "../hash";
import { createEpsGateway } from "../http";

// Fake values built at run time; nothing here is a real credential.
const creds = epsCredentials({
  mode: "sandbox",
  merchantId: "m".repeat(10),
  storeId: "s".repeat(10),
  username: "u".repeat(10),
  password: "p".repeat(10),
  hashKey: "h".repeat(16),
});
const ID = "TCP" + "a".repeat(32);

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A scripted fetch: canned answers in order, every request recorded. A function answer can throw or hang. */
function scripted(answers: Array<Response | (() => Promise<Response>)>) {
  const seen: Seen[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("script ran out");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: f, seen };
}

function clockAt(start: string) {
  let t = new Date(start).getTime();
  const clock: Clock = { now: () => new Date(t) };
  return { clock, advance: (ms: number) => (t += ms) };
}

const tokenOk = (expire = "2030-01-01T00:10:00.1234567") =>
  json({ token: "tok-1", expireDate: expire, errorMessage: null, errorCode: null });
const initOk = () =>
  json({
    TransactionId: "T-1",
    RedirectURL: "https://pg.eps.com.bd/PG?data=T-1",
    ErrorMessage: "",
    ErrorCode: null,
  });
const verifyOk = () =>
  json({
    MerchantTransactionId: ID,
    EpsTransactionId: "C1",
    Status: "Success",
    TotalAmount: "1500.00",
    ErrorCode: "",
  });

function req(over: Partial<InitializeRequest> = {}): InitializeRequest {
  return {
    merchantTransactionId: ID,
    customerOrderId: "order-1",
    totalAmountMinor: 150000n,
    ipAddress: "203.0.113.7",
    productName: "Wallet top-up",
    successUrl: "https://example.test/pay/eps/success",
    failUrl: "https://example.test/pay/eps/fail",
    cancelUrl: "https://example.test/pay/eps/cancel",
    ...over,
  };
}

function setup(answers: Array<Response | (() => Promise<Response>)>, timeoutMs?: number) {
  const s = scripted(answers);
  const c = clockAt("2030-01-01T00:00:00Z");
  const gw = createEpsGateway(creds, {
    fetch: s.fetch,
    clock: c.clock,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { ...s, ...c, gw };
}

describe("hash headers and endpoints", () => {
  it("signs the token call with the user name, initialize and verify with the transaction id", async () => {
    const { gw, seen } = setup([tokenOk(), initOk(), verifyOk()]);
    expect(await gw.initialize(req())).toEqual({
      ok: true,
      redirectUrl: "https://pg.eps.com.bd/PG?data=T-1",
      gatewayTransactionId: "T-1",
    });
    await gw.verify(ID);
    expect(seen[0]).toMatchObject({
      url: "https://sandboxpgapi.eps.com.bd/v1/Auth/GetToken",
      method: "POST",
      headers: { "x-hash": epsHash(creds.hashKey, creds.username) },
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      userName: creds.username,
      password: creds.password,
    });
    expect(seen[1]).toMatchObject({
      url: "https://sandboxpgapi.eps.com.bd/v1/EPSEngine/InitializeEPS",
      method: "POST",
      headers: { "x-hash": epsHash(creds.hashKey, ID), authorization: "Bearer tok-1" },
    });
    expect(seen[2]).toMatchObject({
      url: `https://sandboxpgapi.eps.com.bd/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=${ID}`,
      method: "GET",
      headers: { "x-hash": epsHash(creds.hashKey, ID), authorization: "Bearer tok-1" },
    });
  });

  it("uses the production host in production mode and encodes the id in the query", async () => {
    const s = scripted([tokenOk(), verifyOk()]);
    const prod = epsCredentials({
      mode: "production",
      merchantId: "m",
      storeId: "s",
      username: "u",
      password: "p",
      hashKey: "h",
    });
    const gw = createEpsGateway(prod, {
      fetch: s.fetch,
      clock: clockAt("2030-01-01T00:00:00Z").clock,
    });
    await gw.verify("a b&c");
    expect(s.seen[0]!.url.startsWith("https://pgapi.eps.com.bd/")).toBe(true);
    expect(s.seen[1]!.url).toBe(
      "https://pgapi.eps.com.bd/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=a%20b%26c",
    );
  });
});

describe("token", () => {
  it("is cached for two calls and refreshed after it expires (60 s early)", async () => {
    const { gw, seen, advance } = setup([
      tokenOk("2030-01-01T00:10:00"),
      verifyOk(),
      verifyOk(),
      tokenOk("2030-01-01T00:20:00"),
      verifyOk(),
    ]);
    await gw.verify(ID);
    await gw.verify(ID);
    expect(seen.filter((s) => s.url.endsWith("/GetToken"))).toHaveLength(1);
    advance(9 * 60_000 + 30_000); // 00:09:30 is inside the 60 s margin
    await gw.verify(ID);
    expect(seen.filter((s) => s.url.endsWith("/GetToken"))).toHaveLength(2);
  });

  it("refreshes once on a 401 and retries once", async () => {
    const { gw, seen } = setup([tokenOk(), json({}, 401), tokenOk(), verifyOk()]);
    expect(await gw.verify(ID)).toMatchObject({ ok: true, reading: { status: "success" } });
    expect(seen.map((s) => s.url.split("/").pop())).toEqual([
      "GetToken",
      `CheckMerchantTransactionStatus?merchantTransactionId=${ID}`,
      "GetToken",
      `CheckMerchantTransactionStatus?merchantTransactionId=${ID}`,
    ]);
  });

  it("gives unavailable after a second 401", async () => {
    const { gw, seen } = setup([tokenOk(), json({}, 401), tokenOk(), json({}, 401)]);
    expect(await gw.initialize(req())).toEqual({ ok: false, reason: "unavailable" });
    expect(seen).toHaveLength(4);
  });

  it("gives unavailable when the token call fails or carries an error code", async () => {
    expect(await setup([json({}, 500)]).gw.verify(ID)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await setup([json({ token: null, errorCode: "E1" })]).gw.verify(ID)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await setup([new Response("not json", { status: 200 })]).gw.verify(ID)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("initialize", () => {
  it("gives rejected when ErrorCode is set", async () => {
    const { gw } = setup([
      tokenOk(),
      json({ ErrorCode: "E7", ErrorMessage: "dup", RedirectURL: null }),
    ]);
    expect(await gw.initialize(req())).toEqual({ ok: false, reason: "rejected" });
  });

  it("never returns a redirect that is not https on the hosted gateway", async () => {
    for (const url of [
      "http://evil.test/",
      "https://pg.eps.com.bd.evil.test/",
      "https://evil.test/pg.eps.com.bd",
      "https://user@evil.test/",
      "javascript:alert(1)",
      "not a url",
      "",
      null,
      42,
    ]) {
      const { gw } = setup([
        tokenOk(),
        json({ TransactionId: "T", RedirectURL: url, ErrorCode: null }),
      ]);
      expect(await gw.initialize(req()), String(url)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("accepts the test host in sandbox mode, and the real host in both modes", async () => {
    const { gw } = setup([
      tokenOk(),
      json({ TransactionId: "T", RedirectURL: "https://pg.eps.test/PG?data=1", ErrorCode: null }),
    ]);
    expect(await gw.initialize(req())).toMatchObject({
      ok: true,
      redirectUrl: "https://pg.eps.test/PG?data=1",
    });
  });

  it("refuses the test host in production mode (WPU-D3, C.7)", async () => {
    const prod = epsCredentials({
      mode: "production",
      merchantId: "m",
      storeId: "s",
      username: "u",
      password: "p",
      hashKey: "h",
    });
    const s = scripted([
      tokenOk(),
      json({ TransactionId: "T", RedirectURL: "https://pg.eps.test/PG?data=1", ErrorCode: null }),
      json({ TransactionId: "T", RedirectURL: "https://pg.eps.com.bd/PG?data=1", ErrorCode: null }),
    ]);
    const gw = createEpsGateway(prod, {
      fetch: s.fetch,
      clock: clockAt("2030-01-01T00:00:00Z").clock,
    });
    expect(await gw.initialize(req())).toEqual({ ok: false, reason: "unavailable" });
    expect(await gw.initialize(req())).toMatchObject({
      ok: true,
      redirectUrl: "https://pg.eps.com.bd/PG?data=1",
    });
  });

  it("writes the amount into the body text as 1500.00, never through a float", async () => {
    const { gw, seen } = setup([tokenOk(), initOk()]);
    await gw.initialize(req());
    const body = seen[1]!.body!;
    expect(body).toContain('"totalAmount":1500.00');
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      merchantId: creds.merchantId,
      storeId: creds.storeId,
      CustomerOrderId: "order-1",
      merchantTransactionId: ID,
      transactionTypeId: 1,
      financialEntityId: 0,
      transitionStatusId: 0,
      version: "1",
      ipAddress: "203.0.113.7",
      successUrl: "https://example.test/pay/eps/success",
      failUrl: "https://example.test/pay/eps/fail",
      cancelUrl: "https://example.test/pay/eps/cancel",
      productName: "Wallet top-up",
      customerCity: "Dhaka",
      customerCountry: "BD",
    });
    const tiny = setup([tokenOk(), initOk()]);
    await tiny.gw.initialize(req({ totalAmountMinor: 5n }));
    expect(tiny.seen[1]!.body).toContain('"totalAmount":0.05');
  });

  it("keeps a hostile product name from changing the amount", async () => {
    const { gw, seen } = setup([tokenOk(), initOk()]);
    await gw.initialize(req({ productName: '","totalAmount":1.00,"x":"' }));
    expect(seen[1]!.body!.startsWith('{"totalAmount":1500.00,')).toBe(true);
    expect(JSON.parse(seen[1]!.body!).productName).toBe('","totalAmount":1.00,"x":"');
  });

  it("sends fixed neutral customer fields, never data of a customer (open point 14)", async () => {
    const { gw, seen } = setup([tokenOk(), initOk()]);
    await gw.initialize(req());
    expect(JSON.parse(seen[1]!.body!)).toMatchObject({
      customerName: "Customer",
      customerEmail: "no-reply@example.com",
      customerPhone: "01000000000",
      customerAddress: "Dhaka",
      customerState: "Dhaka",
      customerPostcode: "1000",
    });
  });

  it("does not retry an initialize on a 5xx (it would create a second transaction)", async () => {
    const { gw, seen } = setup([tokenOk(), json({}, 500), json({}, 500)]);
    expect(await gw.initialize(req())).toEqual({ ok: false, reason: "unavailable" });
    expect(seen).toHaveLength(2);
  });

  it("refuses a non-positive amount without calling out", async () => {
    const { gw, seen } = setup([tokenOk(), initOk()]);
    expect(await gw.initialize(req({ totalAmountMinor: 0n }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("verify", () => {
  it("retries twice on a 5xx, then gives unavailable", async () => {
    const { gw, seen } = setup([tokenOk(), json({}, 502), json({}, 503), json({}, 500)]);
    expect(await gw.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(seen).toHaveLength(4);
  });

  it("succeeds on the third try", async () => {
    const { gw } = setup([tokenOk(), json({}, 502), new Response("", { status: 500 }), verifyOk()]);
    expect(await gw.verify(ID)).toMatchObject({
      ok: true,
      reading: { status: "success", totalAmountMinor: 150000n },
    });
  });

  it("retries a network error too", async () => {
    const { gw } = setup([
      tokenOk(),
      () => Promise.reject(new Error("socket hang up")),
      verifyOk(),
    ]);
    expect(await gw.verify(ID)).toMatchObject({ ok: true });
  });

  it("does not retry a 4xx", async () => {
    const { gw, seen } = setup([tokenOk(), json({}, 404)]);
    expect(await gw.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(seen).toHaveLength(2);
  });

  it("turns a malformed body into an unknown reading", async () => {
    for (const res of [
      new Response("<html>", { status: 200 }),
      json("text"),
      json(null),
      json([1]),
    ]) {
      const { gw } = setup([tokenOk(), res]);
      expect(await gw.verify(ID)).toEqual({
        ok: true,
        reading: {
          status: "unknown",
          merchantTransactionId: null,
          epsTransactionId: null,
          totalAmountMinor: null,
          errorCode: null,
        },
      });
    }
  });

  it("gives unavailable for an empty id (the hash refuses it)", async () => {
    const { gw, seen } = setup([tokenOk(), verifyOk()]);
    expect(await gw.verify("")).toEqual({ ok: false, reason: "unavailable" });
    expect(seen).toHaveLength(0);
  });
});

describe("no secret leaves the client", () => {
  it("a fetch that rejects with the password in its message gives a result without it", async () => {
    const boom = () => Promise.reject(new Error("boom " + creds.password + " " + creds.hashKey));
    for (const run of [
      (gw: ReturnType<typeof setup>["gw"]) => gw.verify(ID),
      (gw: ReturnType<typeof setup>["gw"]) => gw.initialize(req()),
    ]) {
      const { gw } = setup([boom, boom, boom, boom]);
      const out = JSON.stringify(await run(gw), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(out).not.toContain(creds.password);
      expect(out).not.toContain(creds.hashKey);
      expect(out).not.toContain("boom");
    }
  });

  it("never throws, even when fetch throws synchronously or the answer has a getter that throws", async () => {
    const gw = createEpsGateway(creds, {
      fetch: (() => {
        throw new Error("sync " + creds.password);
      }) as unknown as typeof fetch,
      clock: clockAt("2030-01-01T00:00:00Z").clock,
    });
    expect(await gw.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(await gw.initialize(req())).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("timeouts", () => {
  it("gives unavailable when fetch never settles", async () => {
    const hang = () => new Promise<Response>(() => {});
    const { gw } = setup([hang], 20);
    const t0 = Date.now();
    expect(await gw.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("gives unavailable when the body never arrives", async () => {
    const stream = new ReadableStream({ start() {} });
    const { gw } = setup(
      [tokenOk(), () => Promise.resolve(new Response(stream, { status: 200 }))],
      20,
    );
    expect(await gw.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
  });
});
