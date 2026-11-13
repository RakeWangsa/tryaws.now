// WPU-Z10 (requirement 6): the manual workflow that ends a staging test session with
// `sst remove --stage staging`. Static rules like the ones of tests/repo/ci-deploy.test.mjs for
// deploy-staging.yml; nothing here calls GitHub or AWS.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const load = (name) => {
  const text = readFileSync(join(root, ".github/workflows", name), "utf8");
  return { text, workflow: parse(text) };
};
const remove = load("remove-staging.yml");
const deploy = load("deploy-staging.yml");
const stepsOf = (job) => job.steps ?? [];
const runText = (step) => (typeof step.run === "string" ? step.run : "");
const usesOf = (job) =>
  stepsOf(job)
    .map((s) => s.uses)
    .filter(Boolean);

describe("remove-staging.yml", () => {
  const { workflow, text } = remove;
  const job = workflow.jobs.remove;

  it("runs by manual dispatch only, from the protected branch, with the typed confirmation", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.confirm.required).toBe(true);
    expect(job.if).toBe("github.ref == 'refs/heads/main' && inputs.confirm == 'staging'");
  });

  it("has one job, in the environment staging", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["remove"]);
    expect(job.environment).toBe("staging");
  });

  it("assumes the same staging deploy role as deploy-staging.yml, with id-token write at job level only", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ "id-token": "write", contents: "read" });
    const assume = (j) => stepsOf(j).find((s) => String(s.uses ?? "").includes("configure-aws"));
    expect(assume(job).with["role-to-assume"]).toBe("${{ vars.TC_STAGING_DEPLOY_ROLE_ARN }}");
    expect(assume(job).with["role-to-assume"]).toBe(
      assume(deploy.workflow.jobs.deploy).with["role-to-assume"],
    );
    expect(assume(job).with["aws-region"]).toBe("ap-southeast-1");
  });

  it("uses exactly the pinned actions of deploy-staging.yml", () => {
    expect(usesOf(job)).toEqual(usesOf(deploy.workflow.jobs.deploy));
    for (const uses of usesOf(job)) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it("runs the locked sst remove for staging, once, and nothing else of sst", () => {
    const runs = stepsOf(job).map(runText).filter(Boolean);
    expect(runs).toContain("pnpm exec sst remove --stage staging");
    expect(runs.filter((r) => /\bsst\b/.test(r))).toEqual(["pnpm exec sst remove --stage staging"]);
    expect(text).not.toMatch(/sst (deploy|secret|diff)\b/);
    expect(text).not.toMatch(/npx\s|pnpm dlx/);
  });

  it("passes the stage configuration of the deploy, TC_STAGE_SIZE included", () => {
    expect(job.env.TC_STAGE_SIZE).toBe("${{ vars.TC_STAGE_SIZE }}");
    for (const [name, value] of Object.entries(deploy.workflow.jobs.deploy.env)) {
      expect(job.env[name], name).toBe(value);
    }
  });

  it("never runs beside a staging deploy and never cancels one", () => {
    expect(workflow.concurrency.group).toBe(deploy.workflow.concurrency.group);
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("cannot reach production and holds no secret expression", () => {
    expect(text).not.toMatch(/TC_PRODUCTION_DEPLOY|--stage production|environment: production/);
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    for (const step of stepsOf(job)) expect(runText(step)).not.toContain("${{");
  });
});
