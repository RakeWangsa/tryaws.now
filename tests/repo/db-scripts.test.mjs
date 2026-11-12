import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const dbPkg = JSON.parse(readFileSync("packages/db/package.json", "utf8"));
const compose = readFileSync("docker-compose.yml", "utf8");

it("root scripts start and migrate the local database", () => {
  expect(pkg.scripts["db:up"]).toBe("docker compose up -d --wait postgres");
  expect(pkg.scripts["db:migrate"]).toBe("pnpm --filter @tc/db migrate");
});

it("@tc/db has its migration scripts, its entry and its testing entry", () => {
  expect(dbPkg.scripts).toEqual({
    typecheck: "tsc --noEmit",
    migrate: "drizzle-kit migrate",
    generate: "drizzle-kit generate",
  });
  expect(dbPkg.exports).toEqual({
    ".": "./index.ts",
    // WPU-I5: the one length rule of the buyer texts, light enough for packages/core to import without the driver.
    "./buyer-rules": "./repositories/customer/buyer-rules.ts",
    "./migrate": "./migrate.ts",
    "./testing": "./testing/index.ts",
  });
});

it("docker-compose.yml pins PostgreSQL to a minor and checks passwords over TCP (scram)", () => {
  expect(compose).toMatch(/^ {4}image: postgres:16\.\d+$/m);
  expect(compose).toContain("POSTGRES_HOST_AUTH_METHOD: scram-sha-256");
  expect(compose).toContain("--auth-host=scram-sha-256");
  expect(compose).not.toMatch(/AUTH_METHOD: trust/);
});

it("docker-compose.yml runs PostgreSQL 16 on the loopback address only", () => {
  for (const line of [
    "  postgres:",
    "    image: postgres:16.10",
    '      - "127.0.0.1:5432:5432"',
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    "      POSTGRES_DB: ticoncloud",
  ]) {
    expect(compose.split("\n")).toContain(line);
  }
});
