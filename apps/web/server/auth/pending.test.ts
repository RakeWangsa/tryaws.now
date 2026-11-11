import { describe, expect, it } from "vitest";
import {
  PENDING_COOKIE,
  clearPendingCookieSpec,
  decodePending,
  encodePending,
  pendingCookieSpec,
} from "./pending.ts";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const nowSeconds = NOW / 1000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const good = { v: 1, p: "signup", e: "a@example.test", t: nowSeconds - 10 };

describe("the pending cookie", () => {
  it("round-trips", () => {
    const raw = encodePending({ p: "reset", e: "a@example.test", t: nowSeconds });
    expect(decodePending(raw, NOW)).toEqual({ p: "reset", e: "a@example.test", t: nowSeconds });
  });

  it("refuses anything that is not exactly what encodePending makes", () => {
    const refused: (string | undefined)[] = [
      undefined,
      "",
      "not base64 !!",
      Buffer.from("not json").toString("base64url"),
      b64([1, 2]),
      b64(null),
      b64({ ...good, v: 2 }),
      b64({ ...good, p: "other" }),
      b64({ ...good, extra: 1 }),
      b64({ v: 1, p: "signup", e: "a@example.test" }),
      b64({ ...good, e: "A@Example.test" }),
      b64({ ...good, e: "not an email" }),
      b64({ ...good, e: 5 }),
      b64({ ...good, t: nowSeconds - 1801 }),
      b64({ ...good, t: nowSeconds + 61 }),
      b64({ ...good, t: 1.5 }),
      b64({ ...good, t: "1" }),
      "A".repeat(600),
    ];
    for (const raw of refused) expect(decodePending(raw, NOW), String(raw).slice(0, 30)).toBeNull();
  });

  it("accepts the edges of the time window", () => {
    expect(decodePending(b64({ ...good, t: nowSeconds - 1800 }), NOW)).not.toBeNull();
    expect(decodePending(b64({ ...good, t: nowSeconds + 60 }), NOW)).not.toBeNull();
  });

  it("the cookie attributes are written down once and pinned", () => {
    expect(pendingCookieSpec("v")).toEqual({
      name: "__Host-tc_pending",
      value: "v",
      maxAge: 1800,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    expect(PENDING_COOKIE).toBe("__Host-tc_pending");
    expect(clearPendingCookieSpec().maxAge).toBe(0);
  });
});
