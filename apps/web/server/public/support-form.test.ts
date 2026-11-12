import { describe, expect, it } from "vitest";
import {
  HONEYPOT_FIELD,
  PUBLIC_SUPPORT_LIMITS,
  publicSupportCore,
  type PublicSupportContext,
} from "./support-form.ts";

const KEY = "k".repeat(40);

function ctx(
  over: Partial<PublicSupportContext> & { calls?: string[] } = {},
): PublicSupportContext {
  const calls = over.calls ?? [];
  return {
    sameOrigin: () => {
      calls.push("origin");
      return true;
    },
    ip: "203.0.113.9",
    limitKey: KEY,
    ref: "abcd1234",
    limit: async () => {
      calls.push("limit");
      return { allowed: true };
    },
    create: async () => {
      calls.push("create");
      return { ok: true, replayed: false };
    },
    log: (event, reason) => calls.push(`log:${event}:${reason}`),
    ...over,
  };
}

const form = (over: Record<string, unknown> = {}) => ({
  email: "Visitor@Example.com",
  name: "Rahim",
  category: "billing",
  subject: "A question",
  message: "How do I top up?\nThank you.",
  [HONEYPOT_FIELD]: "",
  ...over,
});

describe("publicSupportCore", () => {
  it("runs the steps in the R9 order: authorize, validate, rate limit, execute, audit", async () => {
    const calls: string[] = [];
    expect(await publicSupportCore(ctx({ calls }), form())).toEqual({ status: "done" });
    expect(calls).toEqual(["origin", "limit", "create", "log:support.public:ok"]);
  });

  it("stores the lower-cased address, the cleaned name and text, and nothing else", async () => {
    const seen: unknown[] = [];
    await publicSupportCore(
      ctx({
        create: async (input) => {
          seen.push(input);
          return { ok: true, replayed: false };
        },
      }),
      form({ name: "  ", extra: "ignored", phone: "01700000000" }),
    );
    expect(seen).toEqual([
      {
        email: "visitor@example.com",
        name: null,
        category: "billing",
        subject: "A question",
        message: "How do I top up?\nThank you.",
      },
    ]);
  });

  it("a filled honeypot answers done, stores nothing and does not use the limiter", async () => {
    const calls: string[] = [];
    const state = await publicSupportCore(ctx({ calls }), form({ [HONEYPOT_FIELD]: "http://x" }));
    expect(state).toEqual({ status: "done" });
    expect(calls).toEqual(["origin", "log:support.public:honeypot"]);
  });

  it("refuses another origin, no viewer address and no limiter key before anything else", async () => {
    for (const over of [{ sameOrigin: () => false }, { ip: null }, { limitKey: null }]) {
      const calls: string[] = [];
      const state = await publicSupportCore(ctx({ calls, ...over }), form());
      expect(state).toMatchObject({ status: "error", code: "unavailable" });
      expect(calls).not.toContain("create");
    }
  });

  it("names the invalid fields and writes nothing", async () => {
    const calls: string[] = [];
    const state = await publicSupportCore(
      ctx({ calls }),
      form({ email: "nope", category: "root", subject: "a\r\nBcc: x", message: "" }),
    );
    expect(state).toMatchObject({ status: "error", code: "invalid", ref: "abcd1234" });
    if (state.status !== "error") throw new Error("expected error");
    expect([...(state.fields ?? [])].sort()).toEqual(["category", "email", "message", "subject"]);
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("limit");
  });

  it("refuses a message with a control character or over 5000 characters", async () => {
    for (const message of ["bad\u0000text", "x".repeat(5001)]) {
      const state = await publicSupportCore(ctx(), form({ message }));
      expect(state).toMatchObject({ status: "error", code: "invalid" });
    }
  });

  it("limits a network and an address; over the limit nothing is written", async () => {
    const calls: string[] = [];
    const state = await publicSupportCore(
      ctx({ calls, limit: async () => ({ allowed: false, retryAfterSeconds: 90 }) }),
      form(),
    );
    expect(state).toMatchObject({ status: "error", code: "rate_limited", retryAfterSeconds: 90 });
    expect(calls).not.toContain("create");
    expect(PUBLIC_SUPPORT_LIMITS.map((r) => r.kind)).toEqual(["ip", "email"]);
  });

  it("a limiter that throws refuses (R16)", async () => {
    const state = await publicSupportCore(
      ctx({
        limit: async () => {
          throw new Error("down");
        },
      }),
      form(),
    );
    expect(state).toMatchObject({ status: "error", code: "rate_limited" });
  });

  it("is the same answer for a replay (R7)", async () => {
    const calls: string[] = [];
    const state = await publicSupportCore(
      ctx({ calls, create: async () => ({ ok: true, replayed: true }) }),
      form(),
    );
    expect(state).toEqual({ status: "done" });
    expect(calls).toContain("log:support.public:replayed");
  });

  it("answers 'unavailable' when the write fails, and the log line holds no address or text", async () => {
    const calls: string[] = [];
    const state = await publicSupportCore(
      ctx({
        calls,
        create: async () => {
          throw new Error("visitor@example.com is down");
        },
      }),
      form(),
    );
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(state)).not.toContain("example.com");
    expect(calls.filter((c) => c.startsWith("log:"))).toEqual(["log:support.public:failed"]);
  });
});
