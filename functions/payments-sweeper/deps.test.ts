import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { LogEvent } from "@tc/core";
import type { Tx } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { buildSweeper, buildSweeperDeps, type SweeperEnv } from "./deps";
import {
  EPS_SECRET_NAMES,
  NOT_CONFIGURED,
  epsConfigured,
  sstSecrets,
  type SecretSource,
} from "./secrets";

const PLANTED = {
  EpsMerchantId: "PLANTED-MERCHANT",
  EpsStoreId: "PLANTED-STORE",
  EpsUsername: "PLANTED-USER",
  EpsPassword: "PLANTED-PASSWORD",
  EpsHashKey: "PLANTED-HASHKEY",
} as const;

const source: SecretSource = { get: (n) => PLANTED[n] };

function env(over: Partial<SweeperEnv> = {}) {
  const logs: LogEvent[] = [];
  const urls: string[] = [];
  const full: SweeperEnv = {
    config: { mode: "sandbox", baseUrl: "https://cloud.example.com", limit: 25 },
    secrets: source,
    fetch: (async (input: unknown) => {
      urls.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch,
    clock: { now: () => new Date("2026-11-11T00:00:00Z") },
    runTx: async (fn) => fn({ execute: async () => ({ rows: [] }) } as unknown as Tx),
    log: (e) => logs.push(e),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    ...over,
  };
  return { full, logs, urls };
}

describe("sstSecrets", () => {
  const all = Object.fromEntries(Object.entries(PLANTED).map(([k, v]) => [k, { value: v }]));

  it("returns a source for five present secrets", async () => {
    const s = await sstSecrets(async () => all);
    expect(s.get("EpsPassword")).toBe("PLANTED-PASSWORD");
  });

  it("rejects a missing or empty secret by name, never by value", async () => {
    const missing = { ...all };
    delete (missing as Record<string, unknown>).EpsHashKey;
    await expect(sstSecrets(async () => missing)).rejects.toThrow(
      "sweeper: secret EpsHashKey is missing",
    );
    const empty = { ...all, EpsUsername: { value: "" } };
    await expect(sstSecrets(async () => empty)).rejects.toThrow(
      "sweeper: secret EpsUsername is missing",
    );
    const nonString = { ...all, EpsStoreId: { value: 5 as unknown as string } };
    const err = await sstSecrets(async () => nonString).catch((e: Error) => e);
    expect((err as Error).message).toBe("sweeper: secret EpsStoreId is missing");
  });
});

describe("buildSweeperDeps", () => {
  it("runs the handler with nothing to ask: no fetch, one payments_sweep line", async () => {
    const { full, logs, urls } = env();
    const built = buildSweeperDeps(full);
    const report = await built.handler();
    expect(urls).toEqual([]);
    expect(report.checked).toBe(0);
    expect(logs.filter((l) => l.event === "payments_sweep")).toHaveLength(1);
  });

  it("does not print a planted secret from anything it holds", () => {
    const { full } = env();
    const built = buildSweeperDeps(full);
    for (const text of [
      JSON.stringify(built),
      inspect(built, { depth: 6 }),
      String(built.epsDeps.gateway),
    ]) {
      for (const v of Object.values(PLANTED)) expect(text).not.toContain(v);
    }
  });

  it("cannot create a payment", () => {
    expect(() => buildSweeperDeps(env().full).epsDeps.newPaymentId()).toThrow(
      "sweeper: cannot create a payment",
    );
  });

  it("uses a 64-hex limit key that differs between builds", () => {
    const a = buildSweeperDeps(env().full).epsDeps.limitKey;
    const b = buildSweeperDeps(env().full).epsDeps.limitKey;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("maps the eps logger onto a structured event", () => {
    const { full, logs } = env();
    buildSweeperDeps(full).epsDeps.log("eps.sweep", { count: 0, ok: true });
    expect(logs).toEqual([{ event: "eps.sweep", count: 0, ok: true }]);
  });

  it("buildSweeper is the real sweeper when the five secrets are configured", async () => {
    const { full, logs, urls } = env();
    const report = await buildSweeper(full)();
    expect(urls).toEqual([]);
    expect(report.checked).toBe(0);
    expect(logs.map((l) => l.event)).toContain("payments_sweep");
  });

  it("uses the injected gateway instead of building one", () => {
    const gateway = {
      initialize: async () => ({ ok: false as const, reason: "unavailable" as const }),
      verify: async () => ({ ok: false as const, reason: "unavailable" as const }),
    };
    expect(buildSweeperDeps(env({ gateway }).full).epsDeps.gateway).toBe(gateway);
  });
});

// WPU-Z11: production goes live before the EPS production keys exist; each EPS value left empty holds
// the placeholder (scripts/golive/stage-secrets.sh). The job then asks EPS nothing and reads no row.
describe("EPS not configured yet (WPU-Z11)", () => {
  const withPlaceholder = (names: readonly string[]): SecretSource => ({
    get: (n) => (names.includes(n) ? NOT_CONFIGURED : PLANTED[n]),
  });

  it("the placeholder is the literal not-configured", () => {
    expect(NOT_CONFIGURED).toBe("not-configured");
  });

  it("epsConfigured is false as soon as one of the five holds the placeholder", () => {
    expect(epsConfigured(source)).toBe(true);
    for (const name of EPS_SECRET_NAMES) {
      expect(epsConfigured(withPlaceholder([name])), name).toBe(false);
    }
    expect(epsConfigured(withPlaceholder(EPS_SECRET_NAMES))).toBe(false);
  });

  it("sends nothing to EPS, opens no transaction and logs one fixed line", async () => {
    for (const name of EPS_SECRET_NAMES) {
      const runTx = vi.fn(async () => {
        throw new Error("no transaction expected");
      });
      const { full, logs, urls } = env({ secrets: withPlaceholder([name]), runTx });
      const report = await buildSweeper(full)();
      expect(urls, name).toEqual([]);
      expect(runTx, name).not.toHaveBeenCalled();
      expect(report, name).toEqual({
        checked: 0,
        credited: 0,
        expired: 0,
        review: 0,
        unavailable: 0,
        limit: 25,
        backlog: false,
        allUnavailable: false,
      });
      expect(logs, name).toEqual([
        { event: "payments_sweep_skipped", reason: "eps_not_configured" },
      ]);
      const text = JSON.stringify(logs);
      for (const v of Object.values(PLANTED)) expect(text).not.toContain(v);
      expect(text).not.toContain(NOT_CONFIGURED);
    }
  });

  it("ignores the event and answers the same every run", async () => {
    const { full, logs } = env({ secrets: withPlaceholder(EPS_SECRET_NAMES) });
    const run = buildSweeper(full);
    const a = await run({ paymentId: "x" });
    const b = await run(undefined);
    expect(a).toEqual(b);
    expect(logs).toHaveLength(2);
  });
});
