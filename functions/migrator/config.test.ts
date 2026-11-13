import { Resource } from "sst/resource";
import { expect, it } from "vitest";
import { DB_PASSWORD_SECRET as INFRA_NAMES, DB_ROLES } from "../../infra/lib/functions";
import { DB_PASSWORD_SECRETS, envLinks, MIGRATOR_ERROR, readMigratorConfig } from "./config";

const MASTER_PASSWORD = "m@ster:pw/#1";
const env = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    SST_RESOURCE_Postgres: JSON.stringify({
      host: "db.example.test",
      port: 5432,
      username: "tcadmin",
      password: MASTER_PASSWORD,
      database: "ticoncloud",
    }),
    MIGRATIONS_DIR: "/var/task/migrations",
  };
  for (const [role, name] of Object.entries(INFRA_NAMES)) {
    base[`SST_RESOURCE_${name}`] = JSON.stringify({ value: `pw-${role}` });
  }
  return { ...base, ...over };
};
// The links of these tests come from the SST_RESOURCE_<Name> variables of the environment object
// (envLinks); the run-time path through the SST SDK is config-sst.test.ts (WPU-Z15).
const read = (e: Record<string, string | undefined>) => readMigratorConfig(e, envLinks(e));

it("names the same five password secrets as the function table of the infrastructure", () => {
  expect(DB_PASSWORD_SECRETS).toEqual(INFRA_NAMES);
  expect(Object.keys(DB_PASSWORD_SECRETS).sort()).toEqual([...DB_ROLES].sort());
});

it("reads the master URL, the five passwords and the migrations folder", () => {
  const config = read(env());
  const url = new URL(config.masterUrl);
  expect(url.hostname).toBe("db.example.test");
  expect(url.port).toBe("5432");
  expect(url.pathname).toBe("/ticoncloud");
  expect(url.username).toBe("tcadmin");
  expect(decodeURIComponent(url.password)).toBe(MASTER_PASSWORD);
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
  expect(config.rolePasswords.web_rw).toBe("pw-web_rw");
  expect(config.rolePasswords.report_ro).toBe("pw-report_ro");
  expect(config.migrationsDir).toBe("/var/task/migrations");
});

it("allows sslmode require and no weaker one", () => {
  expect(new URL(read(env({ DB_SSLMODE: "require" })).masterUrl).search).toBe("?sslmode=require");
  for (const mode of ["disable", "prefer", "allow", "verify-ca", ""]) {
    expect(() => read(env({ DB_SSLMODE: mode }))).toThrow(MIGRATOR_ERROR);
  }
});

it("fails closed with one fixed message that holds no value", () => {
  const wrongShapes = [
    undefined,
    "not json",
    "null",
    JSON.stringify({}),
    JSON.stringify({ host: "h", port: 5432, username: "u", database: "d" }),
    JSON.stringify({ host: "h/x", port: 5432, username: "u", password: "p", database: "d" }),
    JSON.stringify({ host: "h", port: "x", username: "u", password: "p", database: "d" }),
    JSON.stringify({ host: "h", port: 5432, username: "", password: "p", database: "d" }),
  ];
  const cases: Record<string, string | undefined>[] = wrongShapes.map((v) => ({
    SST_RESOURCE_Postgres: v,
  }));
  for (const name of Object.values(INFRA_NAMES)) {
    cases.push({ [`SST_RESOURCE_${name}`]: undefined });
    cases.push({ [`SST_RESOURCE_${name}`]: JSON.stringify({ value: "" }) });
  }
  cases.push({ MIGRATIONS_DIR: undefined }, { MIGRATIONS_DIR: "" });
  for (const over of cases) {
    let message = "";
    try {
      read(env(over));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message, JSON.stringify(over)).toBe(MIGRATOR_ERROR);
    expect(message).not.toContain(MASTER_PASSWORD);
  }
});

it("does not read DATABASE_URL (a deploy never takes the master user from a variable)", () => {
  expect(() =>
    read(env({ SST_RESOURCE_Postgres: undefined, DATABASE_URL: "postgres://a:b@h/d" })),
  ).toThrow(MIGRATOR_ERROR);
});

it("with its default links, the SST SDK, nothing linked fails with the fixed message (WPU-Z15)", () => {
  // The SDK's own Resource throws for a name that is not linked; the reader must not pass it on.
  expect(() => (Resource as unknown as Record<string, unknown>)["Postgres"]).toThrow();
  expect(() => readMigratorConfig({ MIGRATIONS_DIR: "/var/task/migrations" })).toThrow(
    new RegExp(`^${MIGRATOR_ERROR}$`),
  );
});
