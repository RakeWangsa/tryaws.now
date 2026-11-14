import { expect, it } from "vitest";
import {
  DB_PASSWORD_SECRET as INFRA_NAMES,
  DB_ROLES,
  FIRST_ADMIN_SUB_SECRET as INFRA_FIRST_ADMIN_SUB,
  OPTIONAL_SECRET_PLACEHOLDER as INFRA_PLACEHOLDER,
} from "../../infra/lib/functions";
import { FIRST_ADMIN_NOT_CONFIGURED } from "@tc/db";
import { envLinks } from "@tc/db/links";
import {
  DB_PASSWORD_SECRETS,
  FIRST_ADMIN_SUB_SECRET,
  MIGRATOR_ERROR,
  readMigratorConfig,
} from "./config";

const MASTER_PASSWORD = "m@ster:pw/#1";
const env = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    SST_RESOURCE_Database: JSON.stringify({
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
    SST_RESOURCE_Database: v,
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
    read(env({ SST_RESOURCE_Database: undefined, DATABASE_URL: "postgres://a:b@h/d" })),
  ).toThrow(MIGRATOR_ERROR);
});

it("with its default links, the SST SDK, nothing linked fails with the fixed message (WPU-Z15)", () => {
  // The SDK's own Resource throws for a name that is not linked (packages/db/test/links.test.ts); the
  // reader must not pass it on.
  expect(() => readMigratorConfig({ MIGRATIONS_DIR: "/var/task/migrations" })).toThrow(
    new RegExp(`^${MIGRATOR_ERROR}$`),
  );
});

// WPU-Z18: the optional secret FirstAdminSub, linked to the migrator only. Its raw value is handed on;
// the decision (no secret, malformed, run) is runMigrator's. A missing or empty link is not a failure:
// the migrations must still run when nobody set it.
it("names the same FirstAdminSub secret and placeholder as the function table of the infrastructure", () => {
  expect(FIRST_ADMIN_SUB_SECRET).toBe(INFRA_FIRST_ADMIN_SUB);
  expect(FIRST_ADMIN_NOT_CONFIGURED).toBe(INFRA_PLACEHOLDER);
});

it("reads the raw value of FirstAdminSub, and undefined when it is not linked or empty", () => {
  const sub = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
  const linked = (value: unknown) =>
    read(env({ SST_RESOURCE_FirstAdminSub: JSON.stringify({ value }) })).firstAdminSub;
  expect(linked(sub)).toBe(sub);
  expect(linked("not-configured")).toBe("not-configured");
  expect(linked("")).toBeUndefined();
  expect(linked(42)).toBeUndefined();
  expect(read(env()).firstAdminSub).toBeUndefined();
  expect(read(env({ SST_RESOURCE_FirstAdminSub: "not json" })).firstAdminSub).toBeUndefined();
});

// WPU-X4: the pool account bootstrap. Plain environment values (an ExternalId is not a secret, 6.3),
// handed on raw; the decision is poolAccountDecision of @tc/db. Unset is never a failure of the config.
it("reads TC_STAGE, TC_POOL_ACCOUNT_IDS and TC_POOL_EXTERNAL_ID raw, and undefined when unset", () => {
  const config = read(
    env({
      TC_STAGE: "staging",
      TC_POOL_ACCOUNT_IDS: "111122223333",
      TC_POOL_EXTERNAL_ID: "tc-pool-ext-placeholder-0001",
    }),
  );
  expect(config.stage).toBe("staging");
  expect(config.poolAccountIds).toBe("111122223333");
  expect(config.poolExternalId).toBe("tc-pool-ext-placeholder-0001");
  const bare = read(env());
  expect(bare.stage).toBeUndefined();
  expect(bare.poolAccountIds).toBeUndefined();
  expect(bare.poolExternalId).toBeUndefined();
  expect(read(env({ TC_POOL_EXTERNAL_ID: "" })).poolExternalId).toBeUndefined();
  // a malformed value is not a config failure either: the migrations must still run
  expect(() => read(env({ TC_POOL_EXTERNAL_ID: "bad id" }))).not.toThrow();
});

// Staging deploy of 2026-11-14: SST links a component under its own name. The migrator read "Postgres"
// while the component is sst.aws.Postgres("Database"), found nothing and refused every deploy.
it("reads the master link under the name of the Postgres component in infra/stacks/database.ts", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const stack = readFileSync(
    resolve(import.meta.dirname, "../../infra/stacks/database.ts"),
    "utf8",
  );
  const component = /new sst\.aws\.Postgres\("([A-Za-z0-9]+)"/.exec(stack)?.[1];
  const config = readFileSync(resolve(import.meta.dirname, "config.ts"), "utf8");
  expect(component).toBe("Database");
  expect(config).toContain(`linked(links, "${component}")`);
});
