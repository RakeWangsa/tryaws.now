import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { describe, expect, it, vi } from "vitest";
import type { WebConfig } from "./config.ts";
import { runRecheck, runStartTopUp } from "./topup-core.ts";
import type { RecheckDeps, StartDeps, TopUpFormState } from "./topup-core.ts";

// The action cores with fake dependencies: no database, no EPS call. The orchestration (order of
// R9, mapping of results, redirect allow-list) is what these tests pin; the payment services have
// their own tests in packages/eps.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "0190aaaa-0000-7000-8000-000000000001";
const KEY = "key-0123456789";
const SESSION: CustomerSession = {
  customerId: A,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(0),
};
const RANGE = { minMinor: 10000n, maxMinor: 5000000n };
const ORIGIN = "http://localhost:3000";
const PLANTED = "planted-secret-token-9999";

const config = (fakes: boolean): WebConfig => ({
  stage: "local",
  appOrigin: ORIGIN,
  epsMode: "sandbox",
  fakes,
  fake: { eps: fakes, idp: fakes, sms: fakes },
});
const goodHeaders = () =>
  new Headers({
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "cloudfront-viewer-address": "203.0.113.9:44321",
  });

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`REDIRECT:${to}`);
  }
}

function make(
  over: {
    fakes?: boolean;
    headers?: Headers;
    eps?: unknown;
    range?: typeof RANGE | null;
    auth?: () => Promise<CustomerSession>;
  } = {},
) {
  const calls = { startTopUp: [] as unknown[][], logs: [] as Record<string, unknown>[] };
  const eps = {
    startTopUp: vi.fn(async (...args: unknown[]) => {
      calls.startTopUp.push(args);
      return {
        ok: true,
        value: { paymentId: PAYMENT, redirectUrl: "https://pg.eps.com.bd/pay/x" },
      };
    }),
    recheckPayment: vi.fn(),
  };
  let keyCounter = 0;
  const deps: StartDeps = {
    authenticate: over.auth ?? (async () => SESSION),
    env: async () => ({
      config: config(over.fakes ?? false),
      eps: over.eps === undefined ? (eps as never) : (over.eps as never),
      headers: over.headers ?? goodHeaders(),
      locale: "bn",
    }),
    loadRange: async () => (over.range === undefined ? RANGE : over.range),
    redirect: (to: string): never => {
      throw new Redirected(to);
    },
    newKey: () => `fresh-key-${++keyCounter}-abcdef`,
    newRequestId: () => "abcd1234",
    log: (entry) => calls.logs.push(entry),
  };
  return { deps, eps, calls };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const idle: TopUpFormState = { status: "idle", idempotencyKey: KEY };
const start = (deps: StartDeps, fields: Record<string, string>, prev: TopUpFormState = idle) =>
  runStartTopUp(deps, prev, form({ idempotencyKey: KEY, ...fields }));

async function redirectTarget(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("expected a redirect");
}

describe("runStartTopUp: the happy path", () => {
  it("passes 150000n paisa for '1,500' and for '১৫০০', with the session's customer and the browser's key", async () => {
    for (const typed of ["1,500", "১৫০০"]) {
      const { deps, eps, calls } = make();
      const to = await redirectTarget(start(deps, { amount: typed }));
      expect(to).toBe("https://pg.eps.com.bd/pay/x");
      expect(eps.startTopUp).toHaveBeenCalledTimes(1);
      expect(calls.startTopUp[0]).toEqual([
        SESSION,
        { amountMinor: 150000n, idempotencyKey: KEY },
        { clientIp: expect.any(String) },
      ]);
    }
  });

  it("the customer is the session's: a customerId field in the form is ignored", async () => {
    const { deps, calls } = make();
    await redirectTarget(start(deps, { amount: "1500", customerId: B }));
    expect(calls.startTopUp[0]?.[0]).toEqual(SESSION);
  });
});

describe("runStartTopUp: validation (before any EPS call)", () => {
  const cases: [string, string][] = [
    ["", "required"],
    ["abc", "format"],
    ["500.5", "format"],
    ["9", "too_low"],
    ["999999999", "too_high"],
  ];
  for (const [typed, field] of cases) {
    it(`'${typed}' gives ${field}, keeps the key, and makes no EPS call`, async () => {
      const { deps, eps } = make();
      const state = await start(deps, { amount: typed });
      expect(state).toMatchObject({
        status: "error",
        field: { amount: field },
        idempotencyKey: KEY,
        requestId: "abcd1234",
      });
      expect(eps.startTopUp).not.toHaveBeenCalled();
    });
  }

  it("a missing or malformed key is replaced and the form re-shown, never accepted", async () => {
    for (const bad of [undefined, "", "short", "has space in it!!", "x".repeat(200)]) {
      const { deps, eps } = make();
      const fields: Record<string, string> = { amount: "1500" };
      const data = form(fields);
      if (bad !== undefined) data.set("idempotencyKey", bad);
      const state = await runStartTopUp(deps, idle, data);
      expect(state.status).toBe("idle");
      expect(state.idempotencyKey).toMatch(/^fresh-key-/);
      expect(eps.startTopUp).not.toHaveBeenCalled();
    }
  });

  it("an amount sent as a file is a format error", async () => {
    const { deps, eps } = make();
    const data = form({ idempotencyKey: KEY });
    data.set("amount", new File(["1500"], "a.txt"));
    expect(await runStartTopUp(deps, idle, data)).toMatchObject({ field: { amount: "format" } });
    expect(eps.startTopUp).not.toHaveBeenCalled();
  });
});

describe("runStartTopUp: authenticate, authorize (R9, R16)", () => {
  it("cross-site and missing Origin are refused with no EPS call", async () => {
    for (const headers of [
      new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      new Headers({ "sec-fetch-site": "same-origin" }),
      new Headers({ origin: ORIGIN, "sec-fetch-site": "cross-site" }),
    ]) {
      const { deps, eps } = make({ headers });
      const state = await start(deps, { amount: "1500" });
      expect(state).toMatchObject({ status: "error", code: "unavailable" });
      expect(eps.startTopUp).not.toHaveBeenCalled();
    }
  });

  it("no session redirects to the login; an unavailable identity service is 'unavailable'", async () => {
    const none = make({
      auth: async () => {
        throw new AuthError("unauthenticated", "no_cookie");
      },
    });
    expect(await redirectTarget(start(none.deps, { amount: "1500" }))).toBe(
      "/en/login?next=%2Fwallet%2Ftopup",
    );
    const down = make({
      auth: async () => {
        throw new AuthError("upstream_unavailable", "unavailable");
      },
    });
    expect(await start(down.deps, { amount: "1500" })).toMatchObject({ code: "unavailable" });
    expect(down.eps.startTopUp).not.toHaveBeenCalled();
  });

  it("eps === null and a closed market are 'not_open'", async () => {
    const noEps = make({ eps: null });
    expect(await start(noEps.deps, { amount: "1500" })).toMatchObject({ code: "not_open" });
    const closed = make({ range: null });
    expect(await start(closed.deps, { amount: "1500" })).toMatchObject({ code: "not_open" });
    expect(closed.eps.startTopUp).not.toHaveBeenCalled();
  });

  it("an address that cannot be read is refused (R16) outside fake mode", async () => {
    const headers = new Headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
    const { deps, eps } = make({ headers });
    expect(await start(deps, { amount: "1500" })).toMatchObject({
      status: "error",
      code: "unavailable",
    });
    expect(eps.startTopUp).not.toHaveBeenCalled();
  });
});

describe("runStartTopUp: results of the payment service", () => {
  const fails = (result: unknown) => {
    const m = make();
    m.eps.startTopUp.mockImplementation(async () => result as never);
    return m;
  };

  it("conflict with ref (same key again) goes to that payment's status page", async () => {
    const { deps } = fails({ ok: false, error: "conflict", ref: PAYMENT });
    expect(await redirectTarget(start(deps, { amount: "1500" }))).toBe(
      `/en/wallet/topup/${PAYMENT}`,
    );
  });

  it("conflict without ref (same key, other amount) returns 'conflict' and a fresh key", async () => {
    const { deps } = fails({ ok: false, error: "conflict" });
    const state = await start(deps, { amount: "1500" });
    expect(state).toMatchObject({ status: "error", code: "conflict" });
    expect(state.idempotencyKey).not.toBe(KEY);
  });

  it("rate_limited carries the seconds and keeps the key", async () => {
    const { deps } = fails({ ok: false, error: "rate_limited", data: { retryAfterSeconds: 42 } });
    expect(await start(deps, { amount: "1500" })).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 42,
      idempotencyKey: KEY,
    });
  });

  it("validation out_of_range that the action's own range does not explain is 'internal' with a reference", async () => {
    const { deps } = fails({ ok: false, error: "validation", fields: { amount: "out_of_range" } });
    const state = await start(deps, { amount: "200" });
    expect(state).toMatchObject({ status: "error", code: "internal", requestId: "abcd1234" });
  });

  it("upstream_unavailable and internal give a reference id and a fresh key, and no dependency text", async () => {
    for (const error of ["upstream_unavailable", "internal"] as const) {
      const { deps, calls } = fails({ ok: false, error, data: PLANTED, ref: PLANTED });
      const state = await start(deps, { amount: "1500" });
      expect(state).toMatchObject({
        status: "error",
        code: error === "internal" ? "internal" : "unavailable",
        requestId: "abcd1234",
      });
      expect(state.idempotencyKey).not.toBe(KEY);
      expect(JSON.stringify(state)).not.toContain(PLANTED);
      expect(JSON.stringify(calls.logs)).not.toContain(PLANTED);
    }
  });

  it("an exception of the service is 'internal' and its text is nowhere", async () => {
    const m = make();
    m.eps.startTopUp.mockRejectedValue(new Error(`boom ${PLANTED}`));
    const state = await start(m.deps, { amount: "1500" });
    expect(state).toMatchObject({ code: "internal", requestId: "abcd1234" });
    expect(JSON.stringify(state)).not.toContain(PLANTED);
    expect(JSON.stringify(m.calls.logs)).not.toContain(PLANTED);
  });
});

describe("runStartTopUp: the redirect allow-list (R16)", () => {
  const withUrl = (url: unknown, fakes: boolean) => {
    const m = make({ fakes });
    m.eps.startTopUp.mockImplementation(
      async () => ({ ok: true, value: { paymentId: PAYMENT, redirectUrl: url } }) as never,
    );
    return m;
  };

  it("off the list, outside fake mode: 'unavailable', logs eps.redirect_refused without the URL, never redirects", async () => {
    for (const url of [
      "https://evil.example/pay",
      "http://pg.eps.com.bd/pay",
      "/dev/eps/checkout?data=abc",
      "//evil.example",
    ]) {
      const { deps, calls } = withUrl(url, false);
      const state = await start(deps, { amount: "1500" });
      expect(state).toMatchObject({ code: "unavailable", requestId: "abcd1234" });
      expect(calls.logs).toContainEqual(
        expect.objectContaining({ event: "eps.redirect_refused", paymentId: PAYMENT }),
      );
      expect(JSON.stringify(calls.logs)).not.toContain("evil.example");
      expect(JSON.stringify(calls.logs)).not.toContain("/dev/eps");
    }
  });

  it("in fake mode the dev checkout path is allowed, in the language's prefix; other paths are not", async () => {
    const ok = withUrl("/dev/eps/checkout?data=abc-123", true);
    expect(await redirectTarget(start(ok.deps, { amount: "1500" }))).toBe(
      "/en/dev/eps/checkout?data=abc-123",
    );
    const bad = withUrl("/dev/eps/checkout/../../admin", true);
    expect(await start(bad.deps, { amount: "1500" })).toMatchObject({ code: "unavailable" });
    const other = withUrl("https://evil.example/", true);
    expect(await start(other.deps, { amount: "1500" })).toMatchObject({ code: "unavailable" });
  });
});

describe("runRecheck", () => {
  const recheckDeps = (
    over: {
      headers?: Headers;
      eps?: unknown;
      row?: { status: string } | null;
      result?: unknown;
      auth?: () => Promise<CustomerSession>;
    } = {},
  ) => {
    const recheckPayment = vi.fn(
      async () =>
        (over.result ?? { ok: true, value: { state: "credited", review: false } }) as never,
    );
    const deps: RecheckDeps = {
      authenticate: over.auth ?? (async () => SESSION),
      env: async () => ({
        config: config(false),
        eps: over.eps === undefined ? ({ recheckPayment } as never) : (over.eps as never),
        headers: over.headers ?? goodHeaders(),
        locale: "bn",
      }),
      readRow: async () => (over.row === undefined ? { status: "redirected" } : over.row),
      log: () => {},
    };
    return { deps, recheckPayment };
  };

  it("maps ok to the public state and the review flag", async () => {
    const { deps, recheckPayment } = recheckDeps({
      result: { ok: true, value: { state: "pending", review: true } },
    });
    expect(await runRecheck(deps, PAYMENT)).toEqual({ state: "pending", review: true });
    expect(recheckPayment).toHaveBeenCalledWith(SESSION, PAYMENT, {
      clientIp: expect.any(String),
    });
  });

  it("not_found (another customer's id) is 'unknown'", async () => {
    const { deps } = recheckDeps({ result: { ok: false, error: "not_found" } });
    expect(await runRecheck(deps, PAYMENT)).toEqual({ state: "unknown", review: false });
  });

  it("rate_limited reads the row again and carries the seconds (a parallel check may have settled it)", async () => {
    const { deps } = recheckDeps({
      result: { ok: false, error: "rate_limited", data: { retryAfterSeconds: 4 } },
      row: { status: "credited" },
    });
    expect(await runRecheck(deps, PAYMENT)).toEqual({
      state: "credited",
      review: false,
      retryAfterSeconds: 4,
    });
  });

  it("EPS down or an exception is the row's state, never an error text", async () => {
    const down = recheckDeps({ result: { ok: false, error: "upstream_unavailable" } });
    expect(await runRecheck(down.deps, PAYMENT)).toEqual({ state: "pending", review: false });
    const review = recheckDeps({
      result: { ok: false, error: "internal" },
      row: { status: "review" },
    });
    expect(await runRecheck(review.deps, PAYMENT)).toEqual({ state: "pending", review: true });
    const m = recheckDeps();
    m.recheckPayment.mockRejectedValue(new Error(PLANTED));
    const state = await runRecheck(m.deps, PAYMENT);
    expect(JSON.stringify(state)).not.toContain(PLANTED);
    expect(state.state).toBe("pending");
  });

  it("refuses cross-site, a malformed id, no session and eps === null without asking EPS", async () => {
    const unknown = { state: "unknown", review: false };
    const cross = recheckDeps({ headers: new Headers({ origin: "https://evil.example" }) });
    expect(await runRecheck(cross.deps, PAYMENT)).toEqual(unknown);
    const bad = recheckDeps();
    expect(await runRecheck(bad.deps, "../x")).toEqual(unknown);
    const none = recheckDeps({
      auth: async () => {
        throw new AuthError("unauthenticated", "no_cookie");
      },
    });
    expect(await runRecheck(none.deps, PAYMENT)).toEqual(unknown);
    for (const m of [cross, bad, none]) expect(m.recheckPayment).not.toHaveBeenCalled();
    const closed = recheckDeps({ eps: null });
    expect(await runRecheck(closed.deps, PAYMENT)).toEqual({ state: "pending", review: false });
  });
});

describe("source: no floating-point money (R4)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  it("the core and the view do not parse or format numbers with floats", () => {
    for (const file of ["topup-core.ts", "topup-view.ts"]) {
      const text = readFileSync(resolve(here, file), "utf8");
      for (const banned of ["Number(", "parseInt(", "parseFloat(", "toFixed("]) {
        expect(text, `${file} has ${banned}`).not.toContain(banned);
      }
    }
  });
});
