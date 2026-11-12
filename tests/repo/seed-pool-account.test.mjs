import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { childEnv } from "./child-env.mjs";

// WPU-G1: the command line of the pool account bootstrap. No database is reached: every case below
// is refused before a connection is opened. Placeholder ids only.
const BASE = [
  "scripts/seed-pool-account.mjs",
  "--aws-account-id",
  "111111111111",
  "--external-id",
  "tc-ext-placeholder-1",
  "--name",
  "tc-pool-one",
];
const run = (args, env = {}) =>
  spawnSync(process.execPath, [...BASE, ...args], {
    encoding: "utf8",
    env: childEnv({ DATABASE_URL: "", STAGE: "", ...env }),
  });

it("is a root script", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.scripts["seed:pool-account"]).toBe("node scripts/seed-pool-account.mjs");
});

it("refuses a missing or unknown stage before it connects", () => {
  for (const args of [[], ["--stage", "prod"], ["--stage", "Production"]]) {
    const r = run(args);
    expect(r.status, args.join(" ")).toBe(1);
    expect(r.stderr).toMatch(/^seed-pool: the stage/);
  }
});

it("refuses production without the confirmation flag", () => {
  const r = run(["--stage", "production"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^seed-pool: production needs the explicit confirmation/);
});

it("refuses a valid request that has no DATABASE_URL, and never prints the ExternalId", () => {
  const r = run(["--stage", "staging"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^seed-pool: DATABASE_URL is not set\./);
  expect(r.stdout + r.stderr).not.toContain("tc-ext-placeholder-1");
});

it("refuses a malformed account id without echoing it", () => {
  const r = spawnSync(
    process.execPath,
    [
      "scripts/seed-pool-account.mjs",
      "--stage",
      "staging",
      "--aws-account-id",
      "12345",
      "--external-id",
      "tc-ext-placeholder-1",
      "--name",
      "tc-pool-one",
    ],
    { encoding: "utf8", env: childEnv({ DATABASE_URL: "" }) },
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/12 digits/);
  expect(r.stderr).not.toContain("12345");
});
