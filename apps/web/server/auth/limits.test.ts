import { emailSubject, ipSubject } from "@tc/notify";
import type { LimitDecision, LimitRule } from "@tc/db";
import { describe, expect, it } from "vitest";
import { AUTH_LIMITS, buildRules, enforceAuthLimit } from "./limits.ts";

const KEY = "k".repeat(40);
const clock = { now: () => new Date("2026-11-12T10:00:00.000Z") };
const who = { ip: "198.51.100.7", email: "a@example.test" };
const run = <T>(fn: (tx: never) => Promise<T>): Promise<T> => fn({} as never);

describe("AUTH_LIMITS: the table of open point 8", () => {
  const pick = (action: keyof typeof AUTH_LIMITS) =>
    AUTH_LIMITS[action].map((r) => [r.kind, r.scope, r.limit, r.windowSeconds]);

  it("holds the numbers of the plan", () => {
    expect(pick("signup")).toEqual([
      ["ip", "address", 5, 3600],
      ["email", "email", 3, 3600],
    ]);
    expect(pick("confirm")).toEqual([
      ["ip", "address", 20, 3600],
      ["email", "email", 8, 3600],
    ]);
    expect(pick("resend")).toEqual([
      ["email", "email", 1, 60],
      ["email", "email", 3, 3600],
      ["ip", "address", 10, 3600],
    ]);
    expect(pick("signin")).toEqual([
      ["email", "pair", 8, 900],
      ["ip", "address", 30, 900],
      ["email", "email", 40, 3600],
    ]);
    expect(pick("forgot")).toEqual([
      ["email", "email", 3, 3600],
      ["ip", "address", 10, 3600],
    ]);
    expect(pick("reset")).toEqual([
      ["email", "email", 8, 3600],
      ["ip", "address", 20, 3600],
    ]);
  });
});

describe("buildRules", () => {
  it("makes 32-hex subjects from the keyed hashes and no plain address", () => {
    const rules = buildRules(KEY, "signin", who);
    expect(rules).toHaveLength(3);
    for (const rule of rules ?? []) {
      expect(rule.subject).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(rule)).not.toContain("198.51.100.7");
      expect(JSON.stringify(rule)).not.toContain("example.test");
    }
    expect(rules?.[0]?.subject).toBe(emailSubject(KEY, who.email, who.ip));
    expect(rules?.[1]?.subject).toBe(ipSubject(KEY, who.ip));
    expect(rules?.[2]?.subject).toBe(emailSubject(KEY, who.email));
  });

  it("the pair rule differs by address while the email rule does not", () => {
    const a = buildRules(KEY, "signin", who) ?? [];
    const b = buildRules(KEY, "signin", { ...who, ip: "203.0.113.9" }) ?? [];
    expect(a[0]?.subject).not.toBe(b[0]?.subject);
    expect(a[2]?.subject).toBe(b[2]?.subject);
  });

  it("is null for an address that cannot be a subject", () => {
    expect(buildRules(KEY, "signup", { ...who, ip: "nope" })).toBeNull();
  });
});

describe("enforceAuthLimit", () => {
  it("passes the rules to the limiter in one call and allows", async () => {
    const seen: LimitRule[][] = [];
    const consume = async (_tx: unknown, rules: readonly LimitRule[]): Promise<LimitDecision> => {
      seen.push([...rules]);
      return { allowed: true };
    };
    const r = await enforceAuthLimit(run, KEY, clock, "signup", who, consume as never);
    expect(r).toEqual({ allowed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((x) => x.action)).toEqual(["auth.signup", "auth.signup"]);
  });

  it("a refusal carries the retry time and does not throw", async () => {
    const consume = async (): Promise<LimitDecision> => ({
      allowed: false,
      action: "auth.signup",
      retryAfterSeconds: 321,
    });
    expect(await enforceAuthLimit(run, KEY, clock, "signup", who, consume as never)).toEqual({
      allowed: false,
      retryAfterSeconds: 321,
    });
  });

  it("a database failure is a refusal (R16)", async () => {
    const consume = async (): Promise<LimitDecision> => {
      throw new Error("db down");
    };
    const r = await enforceAuthLimit(run, KEY, clock, "signup", who, consume as never);
    expect(r.allowed).toBe(false);
  });

  it("a key shorter than 32 characters is a refusal, not a crash", async () => {
    const r = await enforceAuthLimit(run, "short", clock, "signup", who, (async () => ({
      allowed: true,
    })) as never);
    expect(r.allowed).toBe(false);
  });

  it("an unusable address is a refusal and the limiter is not called", async () => {
    let calls = 0;
    const consume = async (): Promise<LimitDecision> => {
      calls += 1;
      return { allowed: true };
    };
    const r = await enforceAuthLimit(
      run,
      KEY,
      clock,
      "signup",
      { ...who, ip: "" },
      consume as never,
    );
    expect(r.allowed).toBe(false);
    expect(calls).toBe(0);
  });
});
