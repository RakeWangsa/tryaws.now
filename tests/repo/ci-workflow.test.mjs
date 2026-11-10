import { readFileSync } from "node:fs";
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
