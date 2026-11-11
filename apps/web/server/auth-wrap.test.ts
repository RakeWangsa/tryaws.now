import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookieSpecs, sessionSetCookies } from "@tc/auth";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import type { ActionContext } from "./auth/context.ts";
import { clearPendingCookieSpec, pendingCookieSpec } from "./auth/pending.ts";
import type { Outcome } from "./auth/state.ts";
import { formOf, makeRunner } from "./auth-wrap.ts";
import type { CookieJar } from "./auth-wrap.ts";
import type { WebRuntime } from "./runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-11-12T10:00:00.000Z");
const clock = { now: () => NOW };
const tokens = {
  accessToken: "header.payload.signature",
  refreshToken: "r1.r2.r3.r4.r5",
  accessExpiresAt: new Date(NOW.getTime() + 3_600_000),
};

function harness(core: (ctx: ActionContext) => Promise<Outcome>) {
  const sets: Parameters<CookieJar["set"]>[0][] = [];
  const redirects: string[] = [];
  const run = makeRunner({
    runtime: async () => ({}) as WebRuntime,
    headers: async () => new Headers(),
    jar: async () => ({ set: (options) => void sets.push(options) }),
    redirect: (to) => {
      redirects.push(to);
      throw new Error("NEXT_REDIRECT");
    },
    context: () => ({ ref: "0a1b2c3d" }) as ActionContext,
  });
  return { sets, redirects, call: () => run(core) };
}

const attributes = (setCookie: string): string[] =>
  setCookie
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase())
    // Next adds an Expires from the Max-Age (the clock of the test host); Max-Age is the authority.
    .filter((part) => !part.startsWith("expires="))
    .sort();

describe("runAction: cookies", () => {
  it("sets the session cookies from the specs, with the attributes of sessionSetCookies", async () => {
    const specs = sessionCookieSpecs(tokens, clock);
    const h = harness(async () => ({
      state: { status: "done", redirectTo: "/wallet" },
      effects: { setCookies: specs, clearCookies: [], pending: null },
    }));
    await expect(h.call()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.sets.map((s) => s.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);

    // What Next writes for cookies().set(...) is its ResponseCookies serialiser; use it on the same calls.
    const response = NextResponse.next();
    for (const options of h.sets) response.cookies.set(options);
    const fromNext = response.headers.getSetCookie();
    const fromAuth = sessionSetCookies(tokens, clock);
    expect(fromNext).toHaveLength(fromAuth.length);
    for (let i = 0; i < fromAuth.length; i++) {
      expect(fromNext[i]?.split(";")[0]).toBe(fromAuth[i]?.split(";")[0]);
      expect(attributes(fromNext[i] as string)).toEqual(attributes(fromAuth[i] as string));
    }
    // VERIFY (open point 9): Secure, HttpOnly, SameSite=Lax, Path=/, a Max-Age, and no Domain.
    for (const line of fromNext) {
      expect(line).toMatch(/; Path=\//);
      expect(line).toMatch(/; HttpOnly/);
      expect(line).toMatch(/; Secure/);
      expect(line).toMatch(/; SameSite=lax/i);
      expect(line).toMatch(/; Max-Age=\d+/);
      expect(line).not.toMatch(/Domain=/i);
    }
  });

  it("sets and clears the pending cookie through its spec", async () => {
    const set = harness(async () => ({
      state: { status: "done", redirectTo: "/verify" },
      effects: { setCookies: [], clearCookies: [], pending: "encoded" },
    }));
    await expect(set.call()).rejects.toThrow();
    expect(set.sets).toEqual([{ ...pendingCookieSpec("encoded") }]);

    const clear = harness(async () => ({
      state: { status: "done", redirectTo: "/login" },
      effects: { setCookies: [], clearCookies: [], pending: "clear" },
    }));
    await expect(clear.call()).rejects.toThrow();
    expect(clear.sets).toEqual([{ ...clearPendingCookieSpec() }]);
  });

  it("a core that throws gives the generic unavailable state and no cookie", async () => {
    const h = harness(async () => {
      throw new Error("provider said: secret detail");
    });
    const state = await h.call();
    expect(state).toMatchObject({ status: "error", code: "unavailable" });
    expect(JSON.stringify(state)).not.toContain("secret detail");
    expect(h.sets).toEqual([]);
    expect(h.redirects).toEqual([]);
  });

  it("redirect is called for done and only for done", async () => {
    const done = harness(async () => ({
      state: { status: "done", redirectTo: "/login?verified=1" },
      effects: { setCookies: [], clearCookies: [], pending: null },
    }));
    await expect(done.call()).rejects.toThrow("NEXT_REDIRECT");
    expect(done.redirects).toEqual(["/login?verified=1"]);

    const error = harness(async () => ({
      state: { status: "error", code: "code_wrong", ref: "0a1b2c3d" },
      effects: { setCookies: [], clearCookies: [], pending: null },
    }));
    expect(await error.call()).toEqual({ status: "error", code: "code_wrong", ref: "0a1b2c3d" });
    expect(error.redirects).toEqual([]);
  });

  it("a redirect thrown by Next is not swallowed as an error", async () => {
    const h = harness(async () => ({
      state: { status: "done", redirectTo: "/wallet" },
      effects: { setCookies: [], clearCookies: [], pending: null },
    }));
    await expect(h.call()).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("formOf", () => {
  it("turns a FormData into an object, the last value of a repeated name winning", () => {
    const data = new FormData();
    data.append("a", "1");
    data.append("a", "2");
    data.append("b", "x");
    expect(formOf(data)).toEqual({ a: "2", b: "x" });
  });
});

describe("no code path builds a cookie string", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("none of app/, server/auth/ and auth-wrap.ts contains a Set-Cookie string or a session cookie name", () => {
    const files = [
      ...walk(resolve(here, "../app")),
      ...walk(resolve(here, "auth")),
      resolve(here, "auth-wrap.ts"),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(/set-cookie/i.test(text), file).toBe(false);
      expect(/__Host-tc_(?:at|rt)\b/.test(text), file).toBe(false);
    }
  });
});
