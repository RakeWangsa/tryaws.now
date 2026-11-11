import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

const ok = { EPS_MODE: "sandbox", PUBLIC_BASE_URL: "https://cloud.example.com" };

function messageOf(env: Record<string, string | undefined>): string {
  try {
    readConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected readConfig to throw");
}

describe("readConfig", () => {
  it("reads a valid environment and defaults the limit", () => {
    expect(readConfig(ok)).toEqual({
      mode: "sandbox",
      baseUrl: "https://cloud.example.com",
      limit: 25,
    });
    expect(readConfig({ ...ok, EPS_MODE: "production", SWEEP_LIMIT: "100" })).toEqual({
      mode: "production",
      baseUrl: "https://cloud.example.com",
      limit: 100,
    });
  });

  it.each([undefined, "live", "", "Sandbox"])("rejects EPS_MODE %s by name", (v) => {
    expect(messageOf({ ...ok, EPS_MODE: v })).toBe("sweeper: EPS_MODE is missing or invalid");
  });

  it.each([undefined, "http://x.example.com", "https://user:pw@x.example.com", "not a url"])(
    "rejects PUBLIC_BASE_URL %s by name",
    (v) => {
      expect(messageOf({ ...ok, PUBLIC_BASE_URL: v })).toBe(
        "sweeper: PUBLIC_BASE_URL is missing or invalid",
      );
    },
  );

  it("never prints the value of a bad URL", () => {
    expect(
      messageOf({ ...ok, PUBLIC_BASE_URL: "https://user:PW-IN-URL@x.example.com" }),
    ).not.toContain("PW-IN-URL");
  });

  it.each(["0", "101", "1.5", "abc", "", "-1", " 5"])("rejects SWEEP_LIMIT %j by name", (v) => {
    const m = messageOf({ ...ok, SWEEP_LIMIT: v });
    expect(m).toBe("sweeper: SWEEP_LIMIT is missing or invalid");
    expect(m).not.toContain(v === "" ? "\u0000" : v === "abc" ? "abc" : "\u0000");
  });

  it("does not look at secret names", () => {
    const cfg = readConfig({ ...ok, EPS_PASSWORD: "leak", EpsPassword: "leak" });
    expect(JSON.stringify(cfg)).not.toContain("leak");
  });
});
