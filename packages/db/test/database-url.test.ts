import { expect, it } from "vitest";
import { databaseUrl, databaseUrlFromEnv, DATABASE_URL_ERROR, LOCAL_DATABASE_URL } from "../env";
import { envLinks } from "../links";

// A password that URL syntax would break, and that must never appear in an error.
const PASSWORD = "p@ss:w/ord#1?x";
const deployed = (over: Record<string, string | undefined> = {}) => ({
  TC_STAGE: "staging",
  DB_HOST: "proxy.example.test",
  DB_PORT: "5432",
  DB_NAME: "ticoncloud",
  DB_USER: "worker_rw",
  DB_PASSWORD_SECRET: "DbPasswordWorkerRw",
  SST_RESOURCE_DbPasswordWorkerRw: JSON.stringify({ value: PASSWORD }),
  ...over,
});
// The links of these tests come from the SST_RESOURCE_<Name> variables of the environment object
// (envLinks); the run-time path through the SST SDK is database-url-sst.test.ts (WPU-Z15).
const fromEnv = (env: Record<string, string | undefined>) => databaseUrlFromEnv(env, envLinks(env));

it("uses DATABASE_URL as it is when it is set (local and test)", () => {
  const url = "postgres://u:p@127.0.0.1:5432/x";
  expect(databaseUrlFromEnv({ DATABASE_URL: url, DB_HOST: "ignored" })).toBe(url);
});

it("builds the URL from the parts and the linked secret, with sslmode verify-full by default", () => {
  const url = new URL(fromEnv(deployed()));
  expect(url.protocol).toBe("postgres:");
  expect(url.hostname).toBe("proxy.example.test");
  expect(url.port).toBe("5432");
  expect(url.pathname).toBe("/ticoncloud");
  expect(url.username).toBe("worker_rw");
  expect(decodeURIComponent(url.password)).toBe(PASSWORD);
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
});

it("accepts sslmode require and verify-full, nothing weaker", () => {
  expect(new URL(fromEnv(deployed({ DB_SSLMODE: "require" }))).search).toBe("?sslmode=require");
  expect(new URL(fromEnv(deployed({ DB_SSLMODE: "verify-full" }))).search).toBe(
    "?sslmode=verify-full",
  );
  for (const mode of ["disable", "allow", "prefer", "verify-ca", "", "REQUIRE", "no-verify"]) {
    expect(() => fromEnv(deployed({ DB_SSLMODE: mode }))).toThrow(DATABASE_URL_ERROR);
  }
});

it("fails closed with one fixed message, without a value, when anything is missing or malformed", () => {
  const bad: Record<string, string | undefined>[] = [
    { DB_HOST: undefined },
    { DB_HOST: "" },
    { DB_HOST: "host/with/slash" },
    { DB_HOST: "user:pw@host" },
    { DB_PORT: undefined },
    { DB_PORT: "54x2" },
    { DB_PORT: "0" },
    { DB_PORT: "70000" },
    { DB_NAME: undefined },
    { DB_NAME: "db?x=1" },
    { DB_USER: undefined },
    { DB_PASSWORD_SECRET: undefined },
    { DB_PASSWORD_SECRET: "Db Password" },
    { DB_PASSWORD_SECRET: "Other" },
    { SST_RESOURCE_DbPasswordWorkerRw: undefined },
    { SST_RESOURCE_DbPasswordWorkerRw: "not json" },
    { SST_RESOURCE_DbPasswordWorkerRw: JSON.stringify({ value: "" }) },
    { SST_RESOURCE_DbPasswordWorkerRw: JSON.stringify({ value: 5 }) },
    { SST_RESOURCE_DbPasswordWorkerRw: JSON.stringify(null) },
  ];
  for (const over of bad) {
    let message = "";
    try {
      fromEnv(deployed(over));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message, JSON.stringify(Object.keys(over))).toBe(DATABASE_URL_ERROR);
    expect(message).not.toContain(PASSWORD);
  }
});

it("an unparsable secret does not leak into the error (no cause)", () => {
  try {
    fromEnv(deployed({ SST_RESOURCE_DbPasswordWorkerRw: `{"value":"${PASSWORD}` }));
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toBe(DATABASE_URL_ERROR);
    expect((error as Error).cause).toBeUndefined();
  }
});

it("databaseUrl: falls back to the local URL only outside a deployed stage", () => {
  expect(databaseUrl({})).toBe(LOCAL_DATABASE_URL);
  expect(databaseUrl({ TC_STAGE: "local" })).toBe(LOCAL_DATABASE_URL);
  expect(databaseUrl({ DATABASE_URL: "" })).toBe(LOCAL_DATABASE_URL);
  expect(() => databaseUrl({ TC_STAGE: "staging" })).toThrow(DATABASE_URL_ERROR);
  expect(() => databaseUrl({ TC_STAGE: "production" })).toThrow(DATABASE_URL_ERROR);
  expect(databaseUrl(deployed(), envLinks(deployed()))).toContain("worker_rw:");
  expect(databaseUrl({ DATABASE_URL: "postgres://a:b@h/d" })).toBe("postgres://a:b@h/d");
});
