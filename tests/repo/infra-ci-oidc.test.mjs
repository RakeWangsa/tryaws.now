import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// WPU-D2 (C.4): static proof of the GitHub OIDC provider and the three CI role templates in infra/org.
// Nothing here talks to AWS. The trust conditions are the ones documented in the comment block of
// .github/workflows/deploy-production.yml (aud, sub = environment name, job_workflow_ref at a v* tag),
// and the environment names are compared with the workflows themselves.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(path, "utf8");
const FILES = [
  "ci-oidc-provider.yaml",
  "ci-deploy-staging.yaml",
  "ci-plan-production.yaml",
  "ci-deploy-production.yaml",
];
const text = Object.fromEntries(FILES.map((n) => [n, read(join(root, "infra", "org", n))]));
const tpl = Object.fromEntries(FILES.map((n) => [n, parse(text[n])]));

const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const resources = (t, type) =>
  Object.entries(t.Resources)
    .filter(([, r]) => r.Type === type)
    .map(([id, r]) => ({ id, ...r }));
const rolesOf = (name) => resources(tpl[name], "AWS::IAM::Role");
const KEY = "token.actions.githubusercontent.com";

const ROLES = [
  {
    file: "ci-deploy-staging.yaml",
    name: "TcCiDeployStaging",
    environment: "staging",
    workflow: "deploy-staging.yml",
  },
  {
    file: "ci-plan-production.yaml",
    name: "TcCiPlanProduction",
    environment: "production-plan",
    workflow: "deploy-production.yml",
  },
  {
    file: "ci-deploy-production.yaml",
    name: "TcCiDeployProduction",
    environment: "production",
    workflow: "deploy-production.yml",
  },
];

describe("the CI OIDC templates parse and hold no account, secret or contact", () => {
  it("are CloudFormation YAML in the long form, with no literal account, key or address", () => {
    for (const name of FILES) {
      expect(tpl[name].AWSTemplateFormatVersion, name).toBe("2010-09-09");
      expect(text[name], name).not.toMatch(/^\s*[^#\n]*:\s+!(Ref|Sub|GetAtt|Join|If)\b/m);
      expect(text[name], name).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9])/);
      expect(text[name], name).not.toMatch(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]{6,}/);
      expect(text[name], name).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{12,}/);
      expect(text[name], name).not.toMatch(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });

  it("take the organisation and the repository as parameters", () => {
    for (const { file } of ROLES) {
      expect(Object.keys(tpl[file].Parameters), file).toEqual(
        expect.arrayContaining(["GitHubOrg", "GitHubRepo"]),
      );
    }
  });
});

describe("the identity provider", () => {
  const [provider] = resources(tpl["ci-oidc-provider.yaml"], "AWS::IAM::OIDCProvider");

  it("is the GitHub Actions issuer with the audience sts.amazonaws.com", () => {
    expect(provider.Properties.Url).toBe("https://token.actions.githubusercontent.com");
    expect(provider.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
  });

  it("is the only resource of its template", () => {
    expect(Object.keys(tpl["ci-oidc-provider.yaml"].Resources)).toHaveLength(1);
  });
});

describe.each(ROLES)("$name", ({ file, name, environment, workflow }) => {
  const [role] = rolesOf(file);
  const trust = role.Properties.AssumeRolePolicyDocument;
  const [statement] = list(trust.Statement);
  const production = file.includes("production");

  it("is the only role of its template, with the documented name", () => {
    expect(rolesOf(file)).toHaveLength(1);
    expect(role.Properties.RoleName).toBe(name);
    expect(role.Properties.MaxSessionDuration).toEqual({ Ref: "MaxSessionSeconds" });
    expect(tpl[file].Parameters.MaxSessionSeconds.Default).toBe(3600);
  });

  it("trusts exactly the provider of its own account, by web identity, in one statement", () => {
    expect(list(trust.Statement)).toHaveLength(1);
    expect(statement.Effect).toBe("Allow");
    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(statement.Principal).toEqual({
      Federated: {
        "Fn::Sub": `arn:aws:iam::\${AWS::AccountId}:oidc-provider/${KEY}`,
      },
    });
  });

  it("requires the audience, the subject of the GitHub environment and the workflow reference", () => {
    const equals = statement.Condition.StringEquals;
    expect(equals[`${KEY}:aud`]).toBe("sts.amazonaws.com");
    expect(equals[`${KEY}:sub`]).toEqual({
      "Fn::Sub": `repo:\${GitHubOrg}/\${GitHubRepo}:environment:${environment}`,
    });
    const ref = production
      ? statement.Condition.StringLike?.[`${KEY}:job_workflow_ref`]
      : equals[`${KEY}:job_workflow_ref`];
    const value = ref["Fn::Sub"];
    expect(value.startsWith("${GitHubOrg}/${GitHubRepo}/.github/workflows/" + workflow + "@")).toBe(
      true,
    );
    expect(value).not.toMatch(/^repo:/);
    if (production) expect(value.endsWith("@refs/tags/v*")).toBe(true);
    else {
      expect(value.endsWith("@refs/heads/${ProtectedBranch}")).toBe(true);
      expect(value).not.toContain("*");
    }
  });

  it("has no wildcard sub, no StringLike on the subject and only the three condition keys", () => {
    const all = JSON.stringify(statement.Condition);
    expect(all).not.toMatch(/:sub":\{?"?[^}]*\*/);
    const keys = Object.values(statement.Condition).flatMap((c) => Object.keys(c));
    expect(keys.sort()).toEqual([`${KEY}:aud`, `${KEY}:job_workflow_ref`, `${KEY}:sub`].sort());
    expect(statement.Condition.StringLike?.[`${KEY}:sub`]).toBeUndefined();
  });

  it("names a GitHub environment and a workflow that exist in .github/workflows", () => {
    const wf = read(join(root, ".github", "workflows", workflow));
    expect(wf).toMatch(new RegExp(`^\\s+environment:\\s+${environment}\\s*$`, "m"));
  });
});

describe("permissions", () => {
  const statementsOf = (file) =>
    rolesOf(file).flatMap((r) =>
      list(r.Properties.Policies).flatMap((p) => list(p.PolicyDocument.Statement)),
    );
  const allowed = (file) =>
    statementsOf(file)
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => list(s.Action));
  const denied = (file) =>
    statementsOf(file)
      .filter((s) => s.Effect === "Deny")
      .flatMap((s) => list(s.Action));

  it("the plan role is the managed read-only policy plus denies, and allows nothing itself", () => {
    const [role] = rolesOf("ci-plan-production.yaml");
    expect(role.Properties.ManagedPolicyArns).toEqual(["arn:aws:iam::aws:policy/ReadOnlyAccess"]);
    expect(allowed("ci-plan-production.yaml")).toEqual([]);
    expect(denied("ci-plan-production.yaml")).toEqual(
      expect.arrayContaining(["iam:Create*", "iam:Put*", "organizations:*", "sts:AssumeRole"]),
    );
  });

  it("no CI role allows a wildcard action, iam:*, sts:* or an assume of a pool or DNS role (R1, R3)", () => {
    for (const file of ["ci-deploy-staging.yaml", "ci-deploy-production.yaml"]) {
      for (const action of allowed(file)) {
        expect(action, file).not.toBe("*");
        expect(action, file).not.toMatch(/^(iam|sts|organizations|account):\*$/);
        expect(action, file).not.toMatch(/^sts:/);
      }
      expect(denied(file), file).toEqual(
        expect.arrayContaining([
          "iam:*",
          "iam:CreateAccessKey",
          "organizations:*",
          "account:*",
          "sts:AssumeRole",
        ]),
      );
    }
  });

  it("the deploy roles may not touch the CI roles or the identity provider, and may not create users", () => {
    for (const file of ["ci-deploy-staging.yaml", "ci-deploy-production.yaml"]) {
      const deny = statementsOf(file).find((s) => s.Sid === "NeverTheCiRolesNorUsersNorKeys");
      const resourceText = JSON.stringify(deny.Resource);
      expect(resourceText).toContain("role/TcCi*");
      expect(resourceText).toContain("oidc-provider/*");
      expect(resourceText).toContain("user/*");
    }
  });

  it("the two deploy templates carry the same permission statements", () => {
    expect(statementsOf("ci-deploy-staging.yaml")).toEqual(
      statementsOf("ci-deploy-production.yaml"),
    );
  });
});
