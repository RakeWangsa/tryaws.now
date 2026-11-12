import { describe, expect, it } from "vitest";
import { notifyMeCore, NOTIFY_ME_LIMITS, type NotifyMeContext } from "./notify-me.ts";

const KEY = "k".repeat(40);

function ctx(over: Partial<NotifyMeContext> & { calls?: string[] } = {}): NotifyMeContext {
  const calls = over.calls ?? [];
  return {
    sameOrigin: () => {
      calls.push("origin");
      return true;
    },
    ip: "203.0.113.9",
    limitKey: KEY,
    ref: "abcd1234",
    limit: async (rules) => {
      calls.push("limit");
      void rules;
      return { allowed: true };
    },
    flag: async () => {
      calls.push("flag");
      return false;
    },
    join: async (input) => {
      calls.push("join");
      void input;
      return { ok: true, replayed: false };
    },
    log: (event, reason) => calls.push(`log:${event}:${reason}`),
    ...over,
  };
}

const form = (over: Record<string, unknown> = {}) => ({
  email: "Visitor@Example.com",
  family: "databases",
  ...over,
});

describe("notifyMeCore", () => {
  it("runs the steps in the R9 order: authorize, validate, rate limit, execute (flag read before the write)", async () => {
    const calls: string[] = [];
    const state = await notifyMeCore(ctx({ calls }), form());
    expect(state).toEqual({ status: "done" });
    expect(calls).toEqual(["origin", "flag", "limit", "join", "log:waitlist.join:ok"]);
  });

  it("writes the lower-cased address and the flag key of the family, and nothing else", async () => {
    const seen: unknown[] = [];
    await notifyMeCore(
      ctx({
        join: async (input) => {
          seen.push(input);
          return { ok: true, replayed: false };
        },
      }),
      form({ family: "object-storage" }),
    );
    expect(seen).toEqual([{ email: "visitor@example.com", productFamily: "bucket" }]);
  });

  it("is the same answer for a replay (R7)", async () => {
    const state = await notifyMeCore(
      ctx({ join: async () => ({ ok: true, replayed: true }) }),
      form(),
    );
    expect(state).toEqual({ status: "done" });
  });

  it("refuses a foreign origin, a missing viewer address and a missing limiter key before anything else", async () => {
    for (const over of [
      { sameOrigin: () => false },
      { ip: null },
      { limitKey: null },
    ] as Partial<NotifyMeContext>[]) {
      const calls: string[] = [];
      const state = await notifyMeCore(ctx({ ...over, calls }), form());
      expect(state).toMatchObject({ status: "error", code: "unavailable", ref: "abcd1234" });
      expect(calls).not.toContain("join");
      expect(calls).not.toContain("limit");
    }
  });

  it("refuses an address that is not valid, and a family that is not on the list, without a limiter or a write", async () => {
    for (const bad of [
      form({ email: "" }),
      form({ email: "not-an-address" }),
      form({ email: "a@b.test\r\nBcc: x@y.test" }),
      form({ family: "linux" }),
      form({ family: "../../etc" }),
      form({ family: undefined }),
    ]) {
      const calls: string[] = [];
      const state = await notifyMeCore(ctx({ calls }), bad);
      expect(state).toMatchObject({ status: "error", code: "invalid" });
      expect(calls).not.toContain("limit");
      expect(calls).not.toContain("join");
    }
  });

  it("does not write when the family's flag is on or cannot be read (R12, R16)", async () => {
    for (const flag of [async () => true, async () => null]) {
      const calls: string[] = [];
      const state = await notifyMeCore(ctx({ calls, flag }), form());
      expect(state).toMatchObject({ status: "error", code: "unavailable" });
      expect(calls).not.toContain("join");
    }
  });

  it("stops at the limiter with the seconds to wait, and never writes", async () => {
    const calls: string[] = [];
    const state = await notifyMeCore(
      ctx({ calls, limit: async () => ({ allowed: false, retryAfterSeconds: 90 }) }),
      form(),
    );
    expect(state).toMatchObject({ status: "error", code: "rate_limited", retryAfterSeconds: 90 });
    expect(calls).not.toContain("join");
  });

  it("answers 'unavailable' when the write fails, and the log line holds no address", async () => {
    const lines: string[] = [];
    const state = await notifyMeCore(
      ctx({
        join: async () => {
          throw new Error("db down for visitor@example.com");
        },
        log: (event, reason) => lines.push(`${event}:${reason}`),
      }),
      form(),
    );
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(lines).toEqual(["waitlist.join:failed"]);
    expect(JSON.stringify(state)).not.toContain("example.com");
  });

  it("limits by network address and by e-mail address, in hashed subjects only (R14)", async () => {
    let rules: readonly unknown[] = [];
    await notifyMeCore(
      ctx({
        limit: async (r) => {
          rules = r;
          return { allowed: true };
        },
      }),
      form(),
    );
    expect(rules).toHaveLength(NOTIFY_ME_LIMITS.length);
    const text = JSON.stringify(rules);
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("example.com");
    for (const rule of rules as { subject: string }[])
      expect(rule.subject).toMatch(/^[0-9a-f]{32}$/);
  });
});
