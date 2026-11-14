// WP0-T6: static rules on the workflows under .github and the behaviour of scripts/post-deploy-check.mjs.
// Nothing here calls GitHub or AWS. The YAML is read as text and parsed with the `yaml` devDependency.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assumeRoleProblems,
  checkOutputs,
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  FEATURE_FLAG_KEYS,
  main,
} from "../../scripts/post-deploy-check.mjs";

const root = resolve(import.meta.dirname, "../..");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const githubFiles = walk(join(root, ".github"));
const workflowFiles = githubFiles.filter((f) => /\.ya?ml$/.test(f) && f.includes("workflows"));
const read = (path) => readFileSync(path, "utf8");
const load = (name) => {
  const text = read(join(root, ".github/workflows", name));
  return { text, workflow: parse(text) };
};
const staging = load("deploy-staging.yml");
const production = load("deploy-production.yml");
const deployWorkflows = [
  ["deploy-staging.yml", staging],
  ["deploy-production.yml", production],
];

const stepsOf = (job) => job.steps ?? [];
const runText = (step) => (typeof step.run === "string" ? step.run : "");

describe("every file under .github", () => {
  // WPU-Z10: remove-staging.yml ends a staging test session (tests/repo/remove-staging.test.mjs).
  // WPU-Z16: omnirank.yml audits the public site (tests/repo/omnirank-workflow.test.mjs).
  it("has the deploy files, the staging removal, the CI file and the OmniRank audit", () => {
    const names = workflowFiles.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual([
      "ci.yml",
      "deploy-production.yml",
      "deploy-staging.yml",
      "omnirank.yml",
      "remove-staging.yml",
    ]);
  });
  it("holds no static AWS key and no AWS secret reference (R3)", () => {
    for (const file of githubFiles) {
      const text = read(file);
      expect(text, file).not.toMatch(/AWS_ACCESS_KEY_ID/);
      expect(text, file).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
      expect(text, file).not.toMatch(/secrets\.AWS_/i);
      expect(text, file).not.toMatch(/aws-access-key-id|aws-secret-access-key/i);
    }
  });
  it("never uses pull_request_target", () => {
    for (const file of githubFiles) expect(read(file), file).not.toMatch(/pull_request_target/);
  });
  it("pins every action to a 40-hex SHA, or marks the line with VERIFY: pin SHA", () => {
    let count = 0;
    for (const file of workflowFiles) {
      for (const line of read(file).split("\n")) {
        const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
        if (!match) continue;
        const ref = match[1];
        if (ref.startsWith("./")) continue;
        count += 1;
        const pinned = /@[0-9a-f]{40}$/.test(ref);
        expect(pinned || line.includes("# VERIFY: pin SHA"), `${file}: ${line.trim()}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(10);
  });
  it("sets permissions at the top level of the workflow", () => {
    for (const file of workflowFiles) {
      const workflow = parse(read(file));
      expect(workflow.permissions, file).toEqual({ contents: "read" });
    }
  });
});

describe.each(deployWorkflows)("%s", (name, { text, workflow }) => {
  const jobs = Object.entries(workflow.jobs);
  it("has no secrets expression, no static key input and no script injection", () => {
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    for (const [, job] of jobs) {
      for (const step of stepsOf(job)) {
        // Expressions go through env: first, never straight into a shell script.
        expect(runText(step), step.name ?? runText(step)).not.toContain("${{");
      }
    }
  });
  it("never echoes or dumps a secret", () => {
    for (const [, job] of jobs) {
      for (const step of stepsOf(job)) {
        const run = runText(step);
        expect(run).not.toMatch(/printenv|set -x|\bcurl\b|\bwget\b/);
        expect(run).not.toMatch(/^\s*env\s*$/m);
        expect(run).not.toMatch(/echo[^\n]*(secret|token|password|\bkey\b|credential)/i);
        expect(run).not.toMatch(/\bsst secret\b/);
      }
    }
  });
  it("is not triggered by a pull request", () => {
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
  });
  it("has one concurrency group that never cancels a running deploy", () => {
    expect(typeof workflow.concurrency.group).toBe("string");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });
  it("gives id-token write only to jobs that assume a role, at job level", () => {
    for (const [id, job] of jobs) {
      const assumes = stepsOf(job).some((s) =>
        String(s.uses ?? "").startsWith("aws-actions/configure-aws-credentials@"),
      );
      if (assumes) {
        expect(job.permissions, id).toEqual({ "id-token": "write", contents: "read" });
        const assume = stepsOf(job).find((s) => String(s.uses ?? "").includes("configure-aws"));
        expect(Object.keys(assume.with).sort(), id).toEqual(
          ["aws-region", "role-duration-seconds", "role-session-name", "role-to-assume"].sort(),
        );
        expect(assume.with["role-to-assume"], id).toMatch(
          /^\$\{\{ vars\.TC_[A-Z_]+_ROLE_ARN \}\}$/,
        );
      } else {
        expect(job.permissions?.["id-token"], id).toBeUndefined();
      }
    }
  });
  it("calls sst deploy only after sst diff in the same job, and nowhere else", () => {
    let deploys = 0;
    for (const [id, job] of jobs) {
      const steps = stepsOf(job);
      const diffAt = steps.findIndex((s) => /\bsst diff\b/.test(runText(s)));
      const deployAt = steps.findIndex((s) => /\bsst deploy\b/.test(runText(s)));
      if (deployAt !== -1) {
        deploys += 1;
        expect(diffAt, id).toBeGreaterThanOrEqual(0);
        expect(diffAt, id).toBeLessThan(deployAt);
      }
    }
    expect(deploys).toBe(1);
  });
  it("does not use a floating sst: it runs the locked one through pnpm exec", () => {
    expect(text).not.toMatch(/npx\s+sst|pnpm dlx|npx\s/);
  });
});

describe("deploy-staging.yml", () => {
  const { workflow, text } = staging;
  it("runs by manual dispatch only, on the protected branch", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.verify.if).toBe("github.ref == 'refs/heads/main'");
  });
  it("uses the environment staging for the deploy job and runs the chosen gate before it", () => {
    expect(workflow.jobs.deploy.environment).toBe("staging");
    expect(workflow.jobs.deploy.needs).toBe("verify");
    expect(stepsOf(workflow.jobs.verify).map(runText)).toContain('pnpm verify --gate "$GATE"');
    expect(workflow.on.workflow_dispatch.inputs.gate.type).toBe("choice");
  });
  it("cannot reach the production stage", () => {
    expect(text).not.toMatch(/TC_PRODUCTION_DEPLOY|--stage production|environment: production/);
  });
});

describe("deploy-production.yml", () => {
  const { workflow, text } = production;
  const jobs = Object.entries(workflow.jobs);
  it("triggers only on a version tag", () => {
    expect(Object.keys(workflow.on)).toEqual(["push"]);
    expect(workflow.on.push).toEqual({ tags: ["v*"] });
  });
  it("refuses a tag whose commit is not on the protected branch, before and in the approved job", () => {
    for (const id of ["verify", "deploy"]) {
      const runs = stepsOf(workflow.jobs[id]).map(runText).join("\n");
      expect(runs, id).toContain("git merge-base --is-ancestor");
    }
    expect(stepsOf(workflow.jobs.verify).map(runText).join("\n")).toMatch(/\^v\[0-9\]\+/);
  });
  it("runs gate M5 with no AWS role in that job", () => {
    const steps = stepsOf(workflow.jobs.verify);
    expect(steps.map(runText)).toContain("pnpm verify --gate M5");
    expect(steps.some((s) => String(s.uses ?? "").includes("aws-actions"))).toBe(false);
    expect(workflow.jobs.verify.permissions).toBeUndefined();
  });
  it("uses the environment production for the job that deploys, which needs the plan job", () => {
    expect(workflow.jobs.deploy.environment).toBe("production");
    expect(workflow.jobs.deploy.needs).toBe("plan");
    expect(workflow.jobs.plan.environment).toBe("production-plan");
    expect(workflow.jobs.plan.needs).toBe("verify");
    const environments = jobs.map(([, job]) => job.environment).filter(Boolean);
    expect(environments.filter((e) => e === "production")).toHaveLength(1);
  });
  it("assumes a different role in the plan job and in the deploy job", () => {
    const role = (id) =>
      stepsOf(workflow.jobs[id]).find((s) => String(s.uses ?? "").includes("configure-aws")).with[
        "role-to-assume"
      ];
    expect(role("plan")).toBe("${{ vars.TC_PRODUCTION_PLAN_ROLE_ARN }}");
    expect(role("deploy")).toBe("${{ vars.TC_PRODUCTION_DEPLOY_ROLE_ARN }}");
  });
  it("shows sst diff in the job summary of the plan job, which has no deploy step", () => {
    const runs = stepsOf(workflow.jobs.plan).map(runText).join("\n");
    expect(runs).toContain("sst diff --stage production");
    expect(runs).toContain("GITHUB_STEP_SUMMARY");
    expect(runs).not.toMatch(/sst deploy/);
  });
  it("sets the production guard variables only on steps that run sst, never at workflow or job level", () => {
    expect(workflow.env?.TC_PRODUCTION_DEPLOY).toBeUndefined();
    expect(workflow.env?.CI).toBeUndefined();
    for (const [id, job] of jobs) {
      expect(job.env?.TC_PRODUCTION_DEPLOY, id).toBeUndefined();
      expect(job.env?.CI, id).toBeUndefined();
      for (const step of stepsOf(job)) {
        if (step.env?.TC_PRODUCTION_DEPLOY !== undefined) {
          expect(step.env.TC_PRODUCTION_DEPLOY).toBe("ci-approved");
          expect(step.env.CI).toBe("true");
          expect(runText(step)).toMatch(/pnpm exec sst (diff|deploy) --stage production/);
          expect(["plan", "deploy"], id).toContain(id);
        }
      }
    }
    // the deploy step is in the approved job only
    const deployJobs = jobs.filter(([, job]) =>
      stepsOf(job).some((s) => /\bsst deploy\b/.test(runText(s))),
    );
    expect(deployJobs.map(([id]) => id)).toEqual(["deploy"]);
  });
  it("ends with the read-only post-deploy check", () => {
    const steps = stepsOf(workflow.jobs.deploy);
    expect(runText(steps[steps.length - 1])).toBe(
      "node scripts/post-deploy-check.mjs --stage production --outputs .sst/outputs.json",
    );
  });
  it("never deploys another stage", () => {
    expect(text).not.toMatch(/--stage staging/);
  });
});

describe("scripts/post-deploy-check.mjs", () => {
  const goodPolicy = {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["sqs:SendMessage", "s3:PutObject"], Resource: "*" },
      { Effect: "Deny", Action: "s3:GetObject", Resource: "*" },
    ],
  };
  const outputs = (patch = {}) =>
    JSON.stringify({
      stage: "production",
      featureFlagDefaults: Object.fromEntries(FEATURE_FLAG_KEYS.map((k) => [k, false])),
      webRolePolicies: [goodPolicy, JSON.stringify(goodPolicy)],
      smsConfigured: true,
      ...patch,
    });
  const check = (text) => checkOutputs({ stage: "production", outputsText: text });

  it("passes when every flag is off and no web policy can assume a role", () => {
    expect(check(outputs()).code).toBe(EXIT_OK);
  });
  it("is BLOCKED when the file is missing, not JSON, or lacks the two keys", () => {
    expect(check(undefined).code).toBe(EXIT_BLOCKED);
    expect(check("not json").code).toBe(EXIT_BLOCKED);
    expect(check("[]").code).toBe(EXIT_BLOCKED);
    expect(check(JSON.stringify({ stage: "production", webUrl: "x" })).code).toBe(EXIT_BLOCKED);
    expect(check(outputs({ webRolePolicies: undefined })).lines.join()).toContain(
      "webRolePolicies",
    );
  });
  it("fails when a flag default is on, missing, or not a boolean false", () => {
    const allOff = Object.fromEntries(FEATURE_FLAG_KEYS.map((k) => [k, false]));
    expect(check(outputs({ featureFlagDefaults: { ...allOff, linux_instance: true } })).code).toBe(
      EXIT_FAILED,
    );
    expect(check(outputs({ featureFlagDefaults: { a: false, b: true } })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ featureFlagDefaults: { a: false } })).lines.join()).toContain(
      "is missing",
    );
    const eleven = Object.fromEntries(Object.entries(allOff).filter(([k]) => k !== "domain"));
    expect(check(outputs({ featureFlagDefaults: eleven })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ featureFlagDefaults: { a: "false" } })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ featureFlagDefaults: {} })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ featureFlagDefaults: null })).code).toBe(EXIT_FAILED);
  });
  // WPU-Y5 (a): production must not run with SMS off unnoticed. The output is a boolean only, never a value.
  it("fails on production when smsConfigured is false or not a boolean, and is BLOCKED when it is missing", () => {
    const off = check(outputs({ smsConfigured: false }));
    expect(off.code).toBe(EXIT_FAILED);
    expect(off.lines.join()).toContain("SMS is not configured");
    expect(check(outputs({ smsConfigured: "true" })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ smsConfigured: null })).code).toBe(EXIT_FAILED);
    const missing = check(outputs({ smsConfigured: undefined }));
    expect(missing.code).toBe(EXIT_BLOCKED);
    expect(missing.lines.join()).toContain("smsConfigured");
    expect(check(outputs()).lines.join("\n")).toContain("OK: SMS is configured in production");
  });
  it("does not ask for SMS on another stage", () => {
    const text = outputs({ stage: "staging", smsConfigured: undefined });
    const result = checkOutputs({ stage: "staging", outputsText: text });
    expect(result.code).toBe(EXIT_OK);
    expect(
      checkOutputs({
        stage: "staging",
        outputsText: outputs({ stage: "staging", smsConfigured: false }),
      }).code,
    ).toBe(EXIT_OK);
  });
  it("fails on a wrong stage", () => {
    expect(check(outputs({ stage: "staging" })).code).toBe(EXIT_FAILED);
  });
  it("fails when a policy allows sts:AssumeRole in any spelling, or cannot be read", () => {
    const allow = (Action) => ({ Statement: [{ Effect: "Allow", Action, Resource: "*" }] });
    for (const action of [
      "sts:AssumeRole",
      "sts:assumerole",
      "sts:*",
      "*",
      ["s3:GetObject", "sts:AssumeRole"],
    ]) {
      expect(assumeRoleProblems([allow(action)]), String(action)).toHaveLength(1);
    }
    expect(
      assumeRoleProblems([{ Statement: [{ Effect: "Allow", NotAction: "s3:*", Resource: "*" }] }]),
    ).toHaveLength(1);
    expect(assumeRoleProblems(["{not json"])).toHaveLength(1);
    expect(assumeRoleProblems([null])).toHaveLength(1);
    expect(
      assumeRoleProblems([{ Statement: { Effect: "Allow", Action: "sts:AssumeRole" } }]),
    ).toHaveLength(1);
    expect(check(outputs({ webRolePolicies: [allow("sts:AssumeRole")] })).code).toBe(EXIT_FAILED);
    expect(check(outputs({ webRolePolicies: [] })).code).toBe(EXIT_FAILED);
  });
  it("a Deny of sts:AssumeRole is not a violation", () => {
    const deny = { Statement: [{ Effect: "Deny", Action: "sts:AssumeRole", Resource: "*" }] };
    expect(assumeRoleProblems([deny])).toEqual([]);
  });
  it("reads only the named file and ends BLOCKED when it is absent (exit code 2 on the command line)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-pdc-"));
    const file = join(dir, "outputs.json");
    expect(main(["--stage", "production", "--outputs", file]).code).toBe(EXIT_BLOCKED);
    writeFileSync(file, outputs());
    expect(main(["--stage", "production", "--outputs", file]).code).toBe(EXIT_OK);
    expect(main([]).code).toBe(EXIT_BLOCKED);
    const run = spawnSync(
      process.execPath,
      [
        join(root, "scripts/post-deploy-check.mjs"),
        "--stage",
        "production",
        "--outputs",
        join(dir, "none.json"),
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(EXIT_BLOCKED);
    expect(run.stdout).toContain("BLOCKED");
  });
  it("imports nothing that can reach the network or AWS", () => {
    const text = read(join(root, "scripts/post-deploy-check.mjs"));
    const imports = [...text.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["node:fs", "node:url"]);
  });
});

describe("CODEOWNERS", () => {
  it("covers workflows, infra and runbooks with the placeholders of the file", () => {
    const text = read(join(root, ".github/CODEOWNERS"));
    const owners = (path) =>
      text
        .split("\n")
        .find((line) => line.startsWith(`${path} `))
        ?.split(/\s+/)
        .slice(1);
    for (const path of ["/.github/", "/infra/", "/docs/runbooks/"]) {
      expect(owners(path), path).toEqual(["@REPLACE-WITH-LEAD", "@REPLACE-WITH-SECOND-REVIEWER"]);
    }
  });
});

// WPU-N1 (audit D.1): infra/lib/stage.ts refuses a staging or production synth without these two, so
// every job that runs sst must pass them from GitHub environment variables.
describe("TC_PROBE_SOURCES and TC_VPC_CIDR reach every sst job", () => {
  for (const [name, { workflow }] of deployWorkflows) {
    it(`${name} passes both from vars.* in each job that runs sst`, () => {
      const sstJobs = Object.entries(workflow.jobs).filter(([, job]) =>
        stepsOf(job).some((s) => /\bsst (diff|deploy)\b/.test(runText(s))),
      );
      expect(sstJobs.length).toBeGreaterThan(0);
      for (const [id, job] of sstJobs) {
        expect(job.env?.TC_PROBE_SOURCES, `${name} ${id}`).toBe("${{ vars.TC_PROBE_SOURCES }}");
        expect(job.env?.TC_VPC_CIDR, `${name} ${id}`).toBe("${{ vars.TC_VPC_CIDR }}");
      }
    });
  }
});

// WPU-Z11: infra/lib/lean.ts reads TC_STAGE_SIZE and unset means "full" (the expensive sizing), so every
// job of every workflow that runs sst passes the variable of its GitHub environment. The check walks all
// workflow files, so a new workflow with an sst job (remove-staging.yml) is held to the same rule.
describe("TC_STAGE_SIZE reaches every sst job (WPU-Z11)", () => {
  const sstJobsOf = (file) =>
    Object.entries(parse(read(file)).jobs ?? {}).filter(([, job]) =>
      stepsOf(job).some((s) => /\bsst (diff|deploy|remove|refresh)\b/.test(runText(s))),
    );

  it("finds the sst jobs of the deploy workflows (plan, deploy, staging deploy)", () => {
    const found = workflowFiles.flatMap((file) =>
      sstJobsOf(file).map(([id]) => `${file.split("/").pop()}:${id}`),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "deploy-production.yml:plan",
        "deploy-production.yml:deploy",
        "deploy-staging.yml:deploy",
      ]),
    );
  });

  it("passes it from vars.TC_STAGE_SIZE at job level in each of them", () => {
    for (const file of workflowFiles) {
      for (const [id, job] of sstJobsOf(file)) {
        expect(job.env?.TC_STAGE_SIZE, `${file} ${id}`).toBe("${{ vars.TC_STAGE_SIZE }}");
        // 2026-11-14: the budget switch travels with the size (infra/lib/lean.ts parseBudgetAlarm).
        expect(job.env?.TC_BUDGET_ALARM, `${file} ${id}`).toBe("${{ vars.TC_BUDGET_ALARM }}");
      }
    }
  });
});

// WPU-Z11 (VERIFY of 2026-11-13): this repository was created after 2026-07-15, so GitHub signs the
// immutable subject form with the owner and repository ids. The comments that tell DevOps what the trust
// policy checks name that form, and the job_workflow_ref value has no "repo:" prefix.
describe("the workflows document the OIDC subject that GitHub sends today (WPU-Z11)", () => {
  for (const [name, { text }] of deployWorkflows) {
    it(`${name} names repo:<org>@<owner-id>/<repo>@<repo-id>:environment:<name>`, () => {
      expect(text).toContain("repo:<org>@<owner-id>/<repo>@<repo-id>:environment:");
      expect(text).not.toMatch(/sub = repo:<org>\/<repo>:/);
      expect(text).not.toMatch(/job_workflow_ref = repo:/);
    });
  }
});

// WPU-Z11 fix round 1: both staging workflows run sst for the staging stage, which adopts the Cognito pools
// kept between test sessions (WPU-Z10), so each passes TC_STAGE_SIZE and the two pool ids from vars.*.
describe("the staging sst jobs pass the stage size and the kept Cognito pool ids", () => {
  for (const [file, jobId] of [
    ["deploy-staging.yml", "deploy"],
    ["remove-staging.yml", "remove"],
  ]) {
    it(`${file}:${jobId}`, () => {
      const env = load(file).workflow.jobs[jobId].env;
      expect(env.TC_STAGE_SIZE).toBe("${{ vars.TC_STAGE_SIZE }}");
      expect(env.TC_COGNITO_CUSTOMER_POOL_ID).toBe("${{ vars.TC_COGNITO_CUSTOMER_POOL_ID }}");
      expect(env.TC_COGNITO_ADMIN_POOL_ID).toBe("${{ vars.TC_COGNITO_ADMIN_POOL_ID }}");
    });
  }
});
