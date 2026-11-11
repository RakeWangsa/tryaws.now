import { describe, expect, it } from "vitest";
import {
  STATUS,
  STUB_CLIENT_ID,
  STUB_POOL_ID,
  blockedHelp,
  childEnv,
  classifyPlaywright,
  exitCodeFor,
  isLocalDatabaseUrl,
  redact,
  summaryLine,
  toBengaliDigits,
} from "./auth-smoke.mjs";

const hex = (() => {
  let n = 0;
  return () => `generated-key-${++n}-${"0".repeat(40)}`;
})();

describe("childEnv", () => {
  it("refuses staging and production", () => {
    for (const stage of ["staging", "production"]) {
      expect(() => childEnv({ TC_STAGE: stage }), stage).toThrow(/refuses TC_STAGE/);
    }
    expect(() => childEnv({ NODE_ENV: "production" })).toThrow(/NODE_ENV/);
  });

  it("refuses a database that is not on this machine and accepts local ones", () => {
    for (const url of [
      "postgres://u:p@db.example.com:5432/x",
      "postgres://u:p@10.0.0.5/x",
      "postgres://u:p@rds.amazonaws.com/x",
    ]) {
      expect(() => childEnv({ DATABASE_URL: url }), url).toThrow(/not on this machine/);
    }
    for (const url of [
      "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud",
      "postgres://u:p@localhost/x",
    ]) {
      expect(() => childEnv({ DATABASE_URL: url }, hex), url).not.toThrow();
    }
    expect(() => childEnv({}, hex)).not.toThrow();
  });

  it("sets all three fake switches in the child and none in the parent", () => {
    const parent = { PATH: "/usr/bin" };
    const { env } = childEnv(parent, hex);
    expect(env.TC_EPS).toBe("fake");
    expect(env.TC_IDP).toBe("fake");
    expect(env.TC_SMS).toBe("fake");
    expect(env.TC_STAGE).toBe("local");
    expect(env.NODE_ENV).toBe("development");
    expect(env.APP_ORIGIN).toBe("http://localhost:3000");
    expect(env.COGNITO_CUSTOMER_POOL_ID).toBe(STUB_POOL_ID);
    expect(env.COGNITO_CUSTOMER_CLIENT_ID).toBe(STUB_CLIENT_ID);
    expect(parent).toEqual({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("passes the generated keys as SST secrets, different from each other", () => {
    const { env, secrets } = childEnv({}, hex);
    const limit = JSON.parse(env.SST_RESOURCE_AuthLimitKey).value;
    const otp = JSON.parse(env.SST_RESOURCE_OtpHashKey).value;
    expect(limit).not.toBe(otp);
    expect(limit.length).toBeGreaterThanOrEqual(32);
    expect(secrets).toContain(limit);
    expect(secrets).toContain(otp);
  });
});

describe("isLocalDatabaseUrl", () => {
  it("is false for nonsense", () => {
    for (const bad of [undefined, null, "", "not a url", 5])
      expect(isLocalDatabaseUrl(bad)).toBe(false);
  });
});

describe("summary lines never print a secret or a stub identifier", () => {
  it("redacts the generated keys and the stub pool identifiers", () => {
    const { secrets } = childEnv({}, hex);
    const line = summaryLine(
      "server",
      STATUS.PASS,
      `key ${secrets[0]} pool ${STUB_POOL_ID} client ${STUB_CLIENT_ID}`,
      secrets,
    );
    for (const secret of secrets) expect(line).not.toContain(secret);
    expect(line).toContain("[hidden]");
    expect(line.startsWith("PASS auth-smoke: server")).toBe(true);
  });

  it("redact leaves other text alone", () => {
    expect(redact("hello", ["x"])).toBe("hello");
    expect(redact("a-secret-b", ["secret"])).toBe("a-[hidden]-b");
  });
});

describe("classifyPlaywright: a missing browser or package is BLOCKED, never a pass", () => {
  it("blocked for a missing browser", () => {
    const out =
      "Error: browserType.launch: Executable doesn't exist at /x/chromium\nRun npx playwright install";
    expect(classifyPlaywright(out, 1)).toBe("blocked");
    expect(classifyPlaywright(out, 0)).toBe("blocked");
  });

  it("blocked for a missing package", () => {
    expect(classifyPlaywright("Error: Cannot find module '@playwright/test'", 1)).toBe("blocked");
    expect(classifyPlaywright("ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'", 1)).toBe(
      "blocked",
    );
  });

  it("pass only for exit 0 with a passed count", () => {
    expect(classifyPlaywright("  2 passed (31s)", 0)).toBe("pass");
    expect(classifyPlaywright("", 0)).toBe("fail");
    expect(classifyPlaywright("no tests found", 0)).toBe("fail");
    expect(classifyPlaywright("  1 passed\n  1 failed", 1)).toBe("fail");
    expect(classifyPlaywright("  2 passed", 1)).toBe("fail");
  });
});

describe("exitCodeFor", () => {
  it("is 0 only when every step passed; BLOCKED and FAIL are not 0; an empty run is not 0", () => {
    expect(exitCodeFor([{ status: STATUS.PASS }, { status: STATUS.PASS }])).toBe(0);
    expect(exitCodeFor([{ status: STATUS.PASS }, { status: STATUS.BLOCKED }])).toBe(3);
    expect(exitCodeFor([{ status: STATUS.BLOCKED }, { status: STATUS.FAIL }])).toBe(1);
    expect(exitCodeFor([])).toBe(1);
  });
});

describe("help texts and digits", () => {
  it("names the exact commands of the plan", () => {
    expect(blockedHelp("playwright")).toContain("pnpm exec playwright install chromium");
    expect(blockedHelp("database")).toContain("pnpm db:up && pnpm db:migrate");
    expect(blockedHelp("port")).toContain("sandbox.network.allowLocalBinding: true");
  });

  it("writes Bengali digits", () => {
    expect(toBengaliDigits("123456")).toBe("১২৩৪৫৬");
    expect(toBengaliDigits("01712345678")).toBe("০১৭১২৩৪৫৬৭৮");
  });
});
