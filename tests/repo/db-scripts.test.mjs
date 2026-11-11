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
  expect(dbPkg.exports).toEqual({ ".": "./index.ts", "./testing": "./testing/index.ts" });
});

it("docker-compose.yml runs PostgreSQL 16 on the loopback address only", () => {
  for (const line of [
    "  postgres:",
    "    image: postgres:16",
    '      - "127.0.0.1:5432:5432"',
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    "      POSTGRES_DB: ticoncloud",
  ]) {
    expect(compose.split("\n")).toContain(line);
  }
});
