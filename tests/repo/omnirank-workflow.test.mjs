import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// WPU-Z16: the OmniRank audit and the IndexNow ping. They read the public site only: no AWS role, no
// secret, no write permission, OmniRank pinned by commit, inputs through env:.
const root = resolve(import.meta.dirname, "../..");
const text = readFileSync(join(root, ".github/workflows/omnirank.yml"), "utf8");
const workflow = parse(text);
const config = JSON.parse(readFileSync(join(root, "omnirank.config.json"), "utf8"));
const steps = (job) => workflow.jobs[job].steps;
const runs = (job) => steps(job).map((s) => (typeof s.run === "string" ? s.run : ""));

describe("omnirank.yml", () => {
  it("runs by hand against staging or production, and after a successful production deploy", () => {
    expect(workflow.on.workflow_dispatch.inputs.target.options).toEqual(["staging", "production"]);
    expect(workflow.on.workflow_dispatch.inputs.target.default).toBe("staging");
    expect(workflow.on.workflow_run.workflows).toEqual(["deploy-production"]);
    expect(workflow.jobs.audit.if).toContain("workflow_run.conclusion == 'success'");
    expect(Object.keys(workflow.on)).not.toContain("pull_request");
  });

  it("installs OmniRank v0.4.0 by its commit in a virtual environment and audits with the repo config", () => {
    expect(workflow.env.OMNIRANK_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(workflow.env.OMNIRANK_COMMIT).toBe("dabe4bedd6e2623aa0160cb584bf5880aaec14bc");
    const all = runs("audit").join("\n");
    expect(all).toContain("python3 -m venv");
    expect(all).toContain(
      "github.com/bemoshiur/OmniRank.git@${OMNIRANK_COMMIT}#subdirectory=scripts/py",
    );
    expect(all).toMatch(/omnirank" audit --config/);
    expect(all).toContain("https://staging.tryaws.now");
    expect(all).toContain("https://tryaws.now");
    // The gates come from the config (audit.failOn): no --fail-on on the command line overrides them.
    expect(all).not.toContain("--fail-on");
  });

  it("holds no secret, no AWS role and no expression inside a script", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/configure-aws-credentials|id-token/);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.keys(workflow.jobs)) {
      for (const run of runs(job)) expect(run).not.toContain("${{");
    }
  });

  it("pings IndexNow for production only", () => {
    expect(runs("indexnow").join("\n")).toContain(
      "node scripts/indexnow-ping.mjs --origin https://tryaws.now",
    );
    expect(workflow.jobs.indexnow.if).toContain("inputs.target == 'production'");
  });
});

describe("omnirank.config.json", () => {
  it("is valid against the parts of OmniRank's schema it uses", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "aeo",
        "audit",
        "crawlers",
        "geo",
        "indexing",
        "nap",
        "sameAs",
        "site",
        "stack",
      ].sort(),
    );
    expect(config.$schema).toContain("/v0.4.0/schemas/omnirank.config.schema.json");
    expect(config.site).toMatchObject({
      name: "TryAWS.now",
      url: "https://tryaws.now",
      entityType: "Organization",
    });
    expect(config.aeo.answerBlock.default).toEqual({ unit: "words", min: 40, max: 60 });
    // sameAs lists only profiles that exist: none yet, so every value is null (the worklist).
    for (const value of Object.values(config.sameAs)) expect(value).toBeNull();
    // No literal secret: OmniRank accepts only env: pointers, and this config needs none.
    expect(config.secrets).toBeUndefined();
  });

  it("names the IndexNow key file that exists", () => {
    const key = config.indexing.indexnowKeyFile;
    expect(key).toMatch(/^apps\/web\/public\/[0-9a-f]{32}\.txt$/);
    expect(readFileSync(join(root, key), "utf8")).toBe(key.slice(-36, -4));
  });
});
