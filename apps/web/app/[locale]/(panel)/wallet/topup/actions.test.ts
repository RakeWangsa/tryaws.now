import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// startTopUpAction with its real wiring (action-env.ts, topup-core.ts) and everything outside the
// app replaced: the session, the request headers, the runtime with a fake EPS, the market range.
// No database is read. The tests that need PostgreSQL (one stored payment for two submits of one
// key, the rate limit counters) live in packages/eps and have not been run in this session.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "0190aaaa-0000-7000-8000-000000000001";
const ORIGIN = "http://localhost:3000";
const KEY = "key-0123456789";
const PLANTED = "planted-secret-token-9999";

const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  authDown: false,
  headers: new Headers(),
  fakes: true,
  epsNull: false,
  range: null as null | { minMinor: bigint; maxMinor: bigint },
  startCalls: [] as unknown[][],
  startImpl: null as null | ((...args: unknown[]) => Promise<unknown>),
  locale: "bn",
  logs: [] as string[],
}));

vi.mock("@tc/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tc/auth")>();
  return {
    ...actual,
    requireCustomer: async () => {
      if (state.authDown) throw new actual.AuthError("upstream_unavailable", "unavailable");
      if (state.session === null) throw new actual.AuthError("unauthenticated", "no_cookie");
      return state.session;
    },
  };
});
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next-intl/server", () => ({ getLocale: async () => state.locale }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("../../../../../server/runtime.ts", () => ({
  getRuntime: async () => ({
    config: { stage: "local", appOrigin: ORIGIN, epsMode: "sandbox", fakes: state.fakes },
    eps: state.epsNull
      ? null
      : {
          startTopUp: async (...args: unknown[]) => {
            state.startCalls.push(args);
            return state.startImpl === null
              ? {
                  ok: true,
                  value: { paymentId: PAYMENT, redirectUrl: "/dev/eps/checkout?data=abc123" },
                }
              : state.startImpl(...args);
          },
        },
  }),
}));
vi.mock("../../../../../server/topup-view.ts", () => ({
  loadRange: async () => state.range,
  loadPayment: async () => null,
}));
vi.mock("../../../../../server/log.ts", () => ({
  writeLog: (entry: Record<string, unknown>) => state.logs.push(JSON.stringify(entry)),
}));

const { startTopUpAction } = await import("./actions.ts");

const goodHeaders = () => new Headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  data.set("idempotencyKey", KEY);
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const idle = { status: "idle", idempotencyKey: KEY } as const;

beforeEach(() => {
  state.session = {
    customerId: A,
    kycStatus: "verified",
    riskTier: "new",
    locale: "bn",
    signedInAt: new Date(0),
  };
  state.authDown = false;
  state.headers = goodHeaders();
  state.fakes = true;
  state.epsNull = false;
  state.range = { minMinor: 10000n, maxMinor: 5000000n };
  state.startCalls = [];
  state.startImpl = null;
  state.locale = "bn";
  state.logs = [];
});

describe("startTopUpAction", () => {
  it("'1,500' and '১৫০০' both start a top-up of 150000n and go to the fake checkout", async () => {
    for (const typed of ["1,500", "১৫০০"]) {
      state.startCalls = [];
      await expect(startTopUpAction(idle, form({ amount: typed }))).rejects.toThrow(
        "REDIRECT:/dev/eps/checkout?data=abc123",
      );
      expect(state.startCalls).toHaveLength(1);
      expect(state.startCalls[0]?.[1]).toEqual({ amountMinor: 150000n, idempotencyKey: KEY });
    }
  });

  it("uses the language of the request in the redirect", async () => {
    state.locale = "en";
    await expect(startTopUpAction(idle, form({ amount: "1500" }))).rejects.toThrow(
      "REDIRECT:/en/dev/eps/checkout?data=abc123",
    );
  });

  it("the same form again: the service answers conflict with the payment, and the customer goes to its page", async () => {
    state.startImpl = async () => ({ ok: false, error: "conflict", ref: PAYMENT });
    await expect(startTopUpAction(idle, form({ amount: "1500" }))).rejects.toThrow(
      `REDIRECT:/wallet/topup/${PAYMENT}`,
    );
  });

  it("the customer is the session's: a field named customerId is ignored (two customers seeded)", async () => {
    await expect(startTopUpAction(idle, form({ amount: "1500", customerId: B }))).rejects.toThrow(
      "REDIRECT",
    );
    expect((state.startCalls[0]?.[0] as { customerId: string }).customerId).toBe(A);
  });

  it("field errors make no EPS call and keep the key", async () => {
    for (const typed of ["", "abc", "500.5", "9", "999999999"]) {
      const result = await startTopUpAction(idle, form({ amount: typed }));
      expect(result).toMatchObject({ status: "error", idempotencyKey: KEY });
    }
    expect(state.startCalls).toEqual([]);
  });

  it("a cross-site or missing Origin is refused with no EPS call", async () => {
    for (const headers of [
      new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      new Headers({}),
    ]) {
      state.headers = headers;
      const result = await startTopUpAction(idle, form({ amount: "1500" }));
      expect(result).toMatchObject({ status: "error", code: "unavailable" });
    }
    expect(state.startCalls).toEqual([]);
  });

  it("no session goes to the login with the top-up as 'next'; an identity outage is 'unavailable'", async () => {
    state.session = null;
    await expect(startTopUpAction(idle, form({ amount: "1500" }))).rejects.toThrow(
      "REDIRECT:/login?next=%2Fwallet%2Ftopup",
    );
    state.session = { customerId: A };
    state.authDown = true;
    expect(await startTopUpAction(idle, form({ amount: "1500" }))).toMatchObject({
      code: "unavailable",
    });
    expect(AuthError).toBeDefined();
  });

  it("no EPS configured and a closed market are 'not_open'", async () => {
    state.epsNull = true;
    expect(await startTopUpAction(idle, form({ amount: "1500" }))).toMatchObject({
      code: "not_open",
    });
    state.epsNull = false;
    state.range = null;
    expect(await startTopUpAction(idle, form({ amount: "1500" }))).toMatchObject({
      code: "not_open",
    });
  });

  it("EPS unavailable: a reference id, no text of the dependency in the state or the log", async () => {
    state.startImpl = async () => {
      throw new Error(`socket hang up ${PLANTED}`);
    };
    const result = await startTopUpAction(idle, form({ amount: "1500" }));
    expect(result).toMatchObject({
      code: "internal",
      requestId: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(state.logs.join("\n")).not.toContain(PLANTED);
  });

  it("a redirect off the allow-list outside fake mode: 'unavailable', a log without the URL, no redirect", async () => {
    state.fakes = false;
    state.startImpl = async () => ({
      ok: true,
      value: { paymentId: PAYMENT, redirectUrl: "https://evil.example/pay?data=abc" },
    });
    state.headers = new Headers({
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "cloudfront-viewer-address": "203.0.113.9:4000",
    });
    const result = await startTopUpAction(idle, form({ amount: "1500" }));
    expect(result).toMatchObject({ code: "unavailable" });
    const log = state.logs.join("\n");
    expect(log).toContain("eps.redirect_refused");
    expect(log).not.toContain("evil.example");
  });

  it("the real gateway host is followed in production mode", async () => {
    state.fakes = false;
    state.startImpl = async () => ({
      ok: true,
      value: { paymentId: PAYMENT, redirectUrl: "https://pg.eps.com.bd/pay?x=1" },
    });
    state.headers = new Headers({
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "cloudfront-viewer-address": "203.0.113.9:4000",
    });
    await expect(startTopUpAction(idle, form({ amount: "1500" }))).rejects.toThrow(
      "REDIRECT:https://pg.eps.com.bd/pay?x=1",
    );
  });
});

describe("source of the top-up screens (R4, U4)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : [];
    });

  it("no Number(, parseInt(, parseFloat( or toFixed( in the screens, the actions, the core or the view", () => {
    const serverDir = resolve(here, "../../../../../server");
    const all = [
      ...files(here),
      resolve(serverDir, "topup-core.ts"),
      resolve(serverDir, "topup-view.ts"),
      resolve(serverDir, "action-env.ts"),
    ];
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      for (const banned of ["Number(", "parseInt(", "parseFloat(", "toFixed("]) {
        expect(text, `${file} has ${banned}`).not.toContain(banned);
      }
    }
  });

  it("no inline style attribute and no dangerouslySetInnerHTML in the screens", () => {
    for (const file of files(here)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bstyle=\{/);
      expect(text, file).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("the Client Components import no server package (the barrel of @tc/core pulls the database driver into the browser; seen in next build)", () => {
    for (const file of [
      resolve(here, "TopUpForm.tsx"),
      resolve(here, "[paymentId]/PaymentWatcher.tsx"),
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text.startsWith('"use client";'), file).toBe(true);
      for (const server of ["@tc/core", "@tc/db", "@tc/eps", "@tc/auth", "@tc/aws"]) {
        expect(text, `${file} imports ${server}`).not.toMatch(
          new RegExp(`^import (?!type )[^;]*from "${server}"`, "m"),
        );
      }
    }
  });

  it('the "use server" files export only async functions', () => {
    for (const file of [resolve(here, "actions.ts"), resolve(here, "[paymentId]/actions.ts")]) {
      const text = readFileSync(file, "utf8");
      expect(text.startsWith('"use server";')).toBe(true);
      const exports = [...text.matchAll(/^export (\w+) (\w+)/gm)];
      for (const [, kind, name] of exports) {
        expect(["async", "type"].includes(kind as string), `${file}: ${kind} ${name}`).toBe(true);
      }
    }
  });
});
