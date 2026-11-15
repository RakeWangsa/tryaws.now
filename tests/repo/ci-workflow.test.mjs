import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const text = readFileSync(".github/workflows/ci.yml", "utf8");
const workflow = parse(text);
const job = Object.values(workflow.jobs)[0];
const scanText = readFileSync(".github/workflows/secret-scan.yml", "utf8");
const scan = parse(scanText);
const scanJob = Object.values(scan.jobs)[0];

// 2026-11-15 (owner: GitHub stays on the free plan): the pull request runs what it changes, the whole suite is
// started by hand, and the secret scan moved to its own workflow that no paths filter can skip (secret-scan.yml).
it("runs on pull requests and by hand only, with read-only permissions", () => {
  expect(Object.keys(workflow.on)).toEqual(["pull_request", "workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
});
it("cancels the older run of a pull request and skips only notes-only changes", () => {
  expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  for (const path of workflow.on.pull_request["paths-ignore"])
    expect(path, path).toMatch(
      /^(JOURNEY\.md|docs\/(legal-drafts|runbooks|screens)\/\*\*|\.superpowers\/\*\*)$/,
    );
});
it("has a PostgreSQL 16 service, pinned to a minor", () => {
  expect(job.services.postgres.image).toMatch(/^postgres:16\.\d+$/);
});
it("runs the checks of spec C.7 in order (secret scan moved), each as a step of its own that always runs", () => {
  // A step that runs a required command has exactly that command as its run text (no `|| true`, no
  // second command), no `if` and no `continue-on-error`; the job has neither either.
  const order = [
    "pnpm install --frozen-lockfile",
    "pnpm lint",
    "pnpm format:check",
    "pnpm typecheck",
    'pnpm exec vitest run --changed "$BASE_SHA"',
    "pnpm audit --audit-level high",
    "pnpm spec:check",
  ];
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  const steps = job.steps.map((step, index) => ({ step, index }));
  let from = -1;
  for (const command of order) {
    const matching = steps.filter(
      ({ step }) => typeof step.run === "string" && step.run.trim() === command,
    );
    expect(matching.length, command).toBe(1);
    const { step, index } = matching[0];
    // Only the tests of the pull request are bound to the pull request event; every other check always runs.
    if (command.startsWith("pnpm exec vitest"))
      expect(step.if).toBe("github.event_name == 'pull_request'");
    else expect(step.if, command).toBeUndefined();
    expect(step["continue-on-error"], command).toBeUndefined();
    expect(index, command).toBeGreaterThan(from);
    from = index;
  }
});
it("keeps the whole suite one click away and never runs the same check twice", () => {
  const runs = job.steps.map((step) => step.run?.trim()).filter(Boolean);
  const whole = job.steps.filter((step) => step.run?.trim() === "pnpm test");
  expect(whole).toHaveLength(1);
  expect(whole[0].if).toBe("github.event_name != 'pull_request'");
  expect(runs).not.toContain("pnpm verify --quick");
  expect(new Set(runs).size).toBe(runs.length);
});
it("scans for secrets in its own workflow, on every pull request, with no paths filter", () => {
  expect(scan.on.pull_request).toBeNull();
  expect(scanText).not.toMatch(/paths-ignore|paths:/);
  expect(scan.permissions).toEqual({ contents: "read" });
  expect(text).not.toContain("gitleaks");
  const runs = scanJob.steps.filter((step) => step.run?.includes("ghcr.io/gitleaks/gitleaks:"));
  expect(runs).toHaveLength(1);
  expect(runs[0].if).toBeUndefined();
  expect(runs[0]["continue-on-error"]).toBeUndefined();
  expect(scanJob["continue-on-error"]).toBeUndefined();
  expect(scanJob.if).toBeUndefined();
  for (const ref of scanJob.steps.map((s) => s.uses).filter(Boolean))
    expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
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
