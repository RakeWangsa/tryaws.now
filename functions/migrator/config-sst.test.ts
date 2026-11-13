import { sealSstLinks, type SealedSstLinks } from "@tc/db/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DB_PASSWORD_SECRETS, readMigratorConfig } from "./config";

// WPU-Z15 (B4): a function deployed by SST 4.17.2 gets its links only in the encrypted link file
// (SST_KEY_FILE, SST_KEY); no SST_RESOURCE_<Name> variable holds them at run time. The SST SDK loads
// its links once per process, so this file holds this one scenario. Fake values (R3).
const MASTER_PASSWORD = "fake-m@ster:pw/#2";
let sealed: SealedSstLinks;
beforeAll(() => {
  const links: Record<string, unknown> = {
    App: { name: "ticoncloud", stage: "staging" },
    Postgres: {
      host: "db.example.test",
      port: 5432,
      username: "tcadmin",
      password: MASTER_PASSWORD,
      database: "ticoncloud",
    },
  };
  for (const [role, name] of Object.entries(DB_PASSWORD_SECRETS)) {
    links[name] = { type: "sst.sst.Secret", value: `fake-pw-${role}` };
  }
  sealed = sealSstLinks(links);
  vi.stubEnv("SST_KEY", sealed.env.SST_KEY);
  vi.stubEnv("SST_KEY_FILE", sealed.env.SST_KEY_FILE);
});
afterAll(() => {
  vi.unstubAllEnvs();
  sealed.remove();
});

it("reads the master user and the five role passwords from the encrypted link file", () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
  const config = readMigratorConfig({ MIGRATIONS_DIR: "/var/task/migrations" });
  const url = new URL(config.masterUrl);
  expect(url.hostname).toBe("db.example.test");
  expect(url.username).toBe("tcadmin");
  expect(decodeURIComponent(url.password)).toBe(MASTER_PASSWORD);
  expect(config.rolePasswords).toEqual({
    web_rw: "fake-pw-web_rw",
    admin_rw: "fake-pw-admin_rw",
    worker_rw: "fake-pw-worker_rw",
    migrator: "fake-pw-migrator",
    report_ro: "fake-pw-report_ro",
  });
});
