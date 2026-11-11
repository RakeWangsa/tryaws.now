import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { SEED_STAGES, assertSeedStage, markKycVerified, parseArgs } from "./seed-kyc-verified.mjs";

const fakeQuery = (rows = [{ id: "x" }]) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
};

describe("the staging-only KYC seed", () => {
  it("lists staging and local, and nothing that looks like production", () => {
    expect(SEED_STAGES).toEqual(["staging", "local"]);
  });

  it("refuses production, a mis-spelt stage, an empty stage and a missing stage before it queries", async () => {
    for (const stage of ["production", "prod", "Staging", "staging ", "", undefined, null, 5]) {
      const db = fakeQuery();
      await expect(
        markKycVerified({ stage, email: "a@example.test", query: db.query }),
      ).rejects.toThrow("staging only");
      expect(db.calls).toEqual([]);
    }
    expect(() => assertSeedStage("production")).toThrow();
  });

  it("refuses a bad address and never echoes it", async () => {
    const db = fakeQuery();
    const secret = "not an address";
    const err = await markKycVerified({ stage: "staging", email: secret, query: db.query }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(secret);
    expect(db.calls).toEqual([]);
  });

  it("changes only kyc_status of one customer, by address, with the address as a parameter", async () => {
    const db = fakeQuery();
    const out = await markKycVerified({
      stage: "staging",
      email: "Test@Example.test",
      query: db.query,
    });
    expect(out).toEqual({ updated: 1 });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/update customers set kyc_status = 'verified'/);
    expect(db.calls[0].sql).not.toContain("Test@Example.test");
    expect(db.calls[0].params).toEqual(["Test@Example.test"]);
  });

  it("reads --stage and --email, and the STAGE variable as the fallback", () => {
    expect(parseArgs(["--stage", "staging", "--email", "a@b.c"], {})).toEqual({
      stage: "staging",
      email: "a@b.c",
    });
    expect(parseArgs([], { STAGE: "production" })).toEqual({
      stage: "production",
      email: undefined,
    });
  });

  it("the runner exits with an error on production and opens no connection", () => {
    const script = fileURLToPath(new URL("../seed-kyc-verified.mjs", import.meta.url));
    const run = spawnSync(
      process.execPath,
      [script, "--stage", "production", "--email", "a@example.test"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, DATABASE_URL: "postgres://nobody@127.0.0.1:1/x" },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("staging only");
    expect(run.stdout).toBe("");
  });
});
