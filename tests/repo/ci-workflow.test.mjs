import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const text = readFileSync(".github/workflows/ci.yml", "utf8");
const workflow = parse(text);
const job = Object.values(workflow.jobs)[0];
const runs = job.steps.map((s) => s.run ?? "").join("\n");

it("runs on pull requests only, with read-only permissions", () => {
  expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
});
it("has a PostgreSQL 16 service", () => {
  expect(job.services.postgres.image).toBe("postgres:16");
});
it("runs the checks of spec C.7 in order", () => {
  const order = [
    "pnpm install --frozen-lockfile",
    "pnpm lint",
    "pnpm format:check",
    "pnpm typecheck",
    "pnpm test",
    "gitleaks",
    "pnpm audit --audit-level high",
    "pnpm verify --quick",
    "pnpm spec:check",
  ];
  let from = 0;
  for (const command of order) {
    const at = runs.indexOf(command, from);
    expect(at, command).toBeGreaterThanOrEqual(0);
    from = at + command.length;
  }
});
it("pins every action to a commit SHA", () => {
  const uses = job.steps.map((s) => s.uses).filter(Boolean);
  expect(uses.length).toBeGreaterThanOrEqual(3);
  for (const ref of uses) expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
});
it("does not deploy", () => {
  expect(text).not.toMatch(/sst deploy|aws-actions|id-token/);
});
it("keeps the mockup out of the secret scan", () => {
  expect(readFileSync(".gitleaks.toml", "utf8")).toContain("design/mockup/");
});
it("gives every step the service database through one job-level DATABASE_URL", () => {
  const service = job.services.postgres;
  const url = new URL(job.env.DATABASE_URL);
  expect(url.protocol).toBe("postgres:");
  expect(url.username).toBe(service.env.POSTGRES_USER ?? "postgres");
  expect(url.password).toBe(service.env.POSTGRES_PASSWORD);
  expect(url.hostname).toBe("localhost");
  expect(url.port).toBe(String(service.ports[0]).split(":")[0]);
  expect(url.pathname).toBe(
    `/${service.env.POSTGRES_DB ?? service.env.POSTGRES_USER ?? "postgres"}`,
  );
  for (const step of job.steps)
    expect(step.env?.DATABASE_URL, step.name ?? step.run).toBeUndefined();
});
