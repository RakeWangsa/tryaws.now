import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  blocked,
  isLocalDatabaseUrl,
  parseTopUpLine,
  seedSql,
  smokeEnv,
} from "./wallet-smoke.mjs";

describe("isLocalDatabaseUrl (R3: the smoke touches a local database only)", () => {
  it("accepts localhost, 127.0.0.1 and ::1", () => {
    for (const url of [
      "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud",
      "postgres://postgres:postgres@localhost:5432/ticoncloud",
      "postgresql://u:p@[::1]:5432/x",
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(true);
    }
  });

  it("refuses every other host, a missing host, a socket path and text that is not a URL", () => {
    for (const url of [
      "postgres://u:p@db.example.com:5432/x",
      "postgres://u:p@10.0.0.5:5432/x",
      "postgres://u:p@tc-prod.cluster-abc.eu-west-1.rds.amazonaws.com/x",
      "postgres://u:p@localhost.evil.example/x",
      "postgres://u:p@127.0.0.1.evil.example/x",
      "postgres:///x?host=/var/run/postgresql",
      "not a url",
      "",
      undefined,
    ]) {
      expect(isLocalDatabaseUrl(url), String(url)).toBe(false);
    }
  });
});

describe("smokeEnv", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x" };

  it("refuses the staging and production stages", () => {
    for (const TC_STAGE of ["staging", "production"]) {
      const out = smokeEnv({ ...base, TC_STAGE });
      expect(out.ok, TC_STAGE).toBe(false);
    }
  });

  it("refuses a database that is not local", () => {
    const out = smokeEnv({ ...base, DATABASE_URL: "postgres://u:p@db.example.com/x" });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("db.example.com");
  });

  it("builds the local environment: stage local, fake EPS, development, the local origin", () => {
    const out = smokeEnv({ ...base, TC_STAGE: "local", NODE_ENV: "production" });
    expect(out.ok).toBe(true);
    expect(out.env).toMatchObject({
      TC_STAGE: "local",
      TC_EPS: "fake",
      NODE_ENV: "development",
      APP_ORIGIN,
      PATH: "/usr/bin",
    });
    expect(out.env.DATABASE_URL).toMatch(/@127\.0\.0\.1:/);
    expect(APP_ORIGIN).toBe("http://localhost:3000");
  });

  it("passes no AWS credential, no SST secret and no other stage variable on (R3)", () => {
    const out = smokeEnv({
      ...base,
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "y",
      AWS_PROFILE: "prod",
      SST_RESOURCE_EpsPassword: '{"value":"secret"}',
      TC_EPS_MODE: "production",
    });
    expect(out.ok).toBe(true);
    const names = Object.keys(out.env);
    expect(names.some((n) => n.startsWith("AWS_"))).toBe(false);
    expect(names.some((n) => n.startsWith("SST_"))).toBe(false);
    expect(names).not.toContain("TC_EPS_MODE");
  });
});

describe("parseTopUpLine", () => {
  it("reads the line that wallet.spec.ts prints for each project", () => {
    expect(
      parseTopUpLine("WALLET-SMOKE bn-360 balance=৳১,৫০০.০০ ledger=1 payments=1 noscroll=true"),
    ).toEqual({
      project: "bn-360",
      balance: "৳১,৫০০.০০",
      ledger: 1,
      payments: 1,
      noScroll: true,
    });
    expect(
      parseTopUpLine("WALLET-SMOKE en-1280 balance=৳1,500.00 ledger=1 payments=1 noscroll=true"),
    ).toMatchObject({ project: "en-1280", balance: "৳1,500.00" });
  });

  it("returns null for any other line and for a line with a missing or odd field", () => {
    for (const line of [
      "",
      "random output",
      "WALLET-SMOKE bn-360",
      "WALLET-SMOKE bn-360 balance=৳1.00 ledger=x payments=1 noscroll=true",
      "WALLET-SMOKE ../x balance=৳1.00 ledger=1 payments=1 noscroll=true",
    ]) {
      expect(parseTopUpLine(line), line).toBeNull();
    }
  });
});

describe("blocked (a skipped proof is a failed proof, R16)", () => {
  it("names the exact commands for each cause", () => {
    expect(blocked("browser")).toMatch(/BLOCKED/);
    expect(blocked("browser")).toContain("pnpm exec playwright install chromium");
    expect(blocked("playwright")).toContain("pnpm add -D -w --save-exact @playwright/test@");
    expect(blocked("database")).toContain("pnpm db:up");
    expect(blocked("database")).toContain("pnpm db:migrate");
    expect(blocked("port")).toContain("allowLocalBinding");
  });
});

describe("seedSql", () => {
  it("names one customer for each project and the payment of someone else", () => {
    const seed = seedSql({ suffix: "abcd1234" });
    expect(seed.subs).toEqual({
      "bn-360": "dev-smoke-bn-abcd1234",
      "en-1280": "dev-smoke-en-abcd1234",
    });
    expect(seed.otherPaymentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    const customers = seed.filter((s) => s.text.includes("insert into customers"));
    expect(customers).toHaveLength(3);
    expect(customers.map((s) => s.values[1])).toContain("dev-smoke-other-abcd1234");
  });

  it("is plain SQL with one bound customer, an active market and the platform accounts; no value is interpolated", () => {
    const statements = seedSql();
    const text = statements.map((s) => s.text).join("\n");
    expect(text).toContain("insert into markets");
    expect(text).toContain("on conflict (code) do update set active = true");
    expect(text).toContain("insert into ledger_accounts");
    expect(text).toContain("insert into wallets");
    expect(text).toContain("'customer_wallet'");
    expect(text).not.toMatch(/\$\{/);
    for (const statement of statements) expect(Array.isArray(statement.values)).toBe(true);
  });
});
