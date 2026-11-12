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

// ---- permissions (security review of WPU-D2: no privilege escalation, no data-plane read) ----------------

/** Statements of a policy document with the two branches of Fn::If kept (a test reads the worst case). */
function expand(statements) {
  return list(statements).flatMap((s) => {
    if (s?.["Fn::If"] !== undefined) {
      return expand(s["Fn::If"].slice(1).filter((b) => b?.Ref !== "AWS::NoValue"));
    }
    return [s];
  });
}
const inlineStatements = (file) =>
  rolesOf(file).flatMap((r) =>
    list(r.Properties.Policies).flatMap((p) => expand(p.PolicyDocument.Statement)),
  );
const managedStatements = (file) =>
  resources(tpl[file], "AWS::IAM::ManagedPolicy").flatMap((p) =>
    expand(p.Properties.PolicyDocument.Statement),
  );
const actionsOf = (statements, effect) =>
  statements.filter((s) => s.Effect === effect).flatMap((s) => list(s.Action));
const resourceText = (s) => JSON.stringify(s.Resource ?? s.NotResource ?? "");
const BOUNDARY_ARN = "arn:aws:iam::${AWS::AccountId}:policy/TcCiRoleBoundary";

describe("deploy roles: no privilege escalation through IAM", () => {
  const files = [
    ["ci-deploy-staging.yaml", ["role/tc-*", "role/ticon-cloud-*"]],
    ["ci-deploy-production.yaml", ["role/tc-production-*", "role/ticon-cloud-production-*"]],
  ];

  describe.each(files)("%s", (file, prefixes) => {
    const statements = inlineStatements(file);
    const allows = statements.filter((s) => s.Effect === "Allow");
    const iamWrites = allows.filter((s) =>
      list(s.Action).some(
        (a) =>
          /^iam:(Create|Put|Attach|Update|PassRole|Delete|Detach|Tag)/.test(a) &&
          a !== "iam:CreateServiceLinkedRole",
      ),
    );

    it("never allows an IAM write on role/* or a bare *, and never grants iam:* or a wildcard action", () => {
      for (const s of allows) {
        for (const a of list(s.Action)) {
          expect(a, file).not.toBe("*");
          expect(a, file).not.toMatch(/^(iam|sts|organizations|account):\*$/);
          expect(a, file).not.toMatch(/^sts:/);
          if (a.startsWith("iam:")) expect(a, file).not.toMatch(/\*/);
        }
      }
      for (const s of iamWrites) {
        for (const r of list(s.Resource).map((x) => JSON.stringify(x))) {
          expect(r, file).not.toMatch(/role\/\*"/);
          expect(r, file).not.toBe('"*"');
          expect(
            prefixes.some((p) => r.includes(p)),
            `${file} ${r}`,
          ).toBe(true);
        }
      }
    });

    it("creates and changes roles only when the role carries the boundary", () => {
      const create = allows.find((s) => list(s.Action).includes("iam:CreateRole"));
      expect(create.Condition.StringEquals["iam:PermissionsBoundary"]).toEqual({
        "Fn::Sub": BOUNDARY_ARN,
      });
      for (const a of [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePermissionsBoundary",
      ]) {
        const s = allows.find((x) => list(x.Action).includes(a));
        expect(s, a).toBeDefined();
        expect(s.Condition.StringEquals["iam:PermissionsBoundary"], a).toEqual({
          "Fn::Sub": BOUNDARY_ARN,
        });
      }
    });

    it("attaches only listed AWS managed policies and passes roles only to listed services", () => {
      const attach = allows.find((s) => s.Action === "iam:AttachRolePolicy");
      const arns = list(attach.Condition.StringEquals["iam:PolicyARN"]);
      expect(arns.length).toBeGreaterThan(0);
      for (const arn of arns)
        expect(arn).toMatch(/^arn:aws:iam::aws:policy\/service-role\/AWSLambda/);
      const pass = allows.find((s) => s.Action === "iam:PassRole");
      const services = list(pass.Condition.StringEquals["iam:PassedToService"]);
      expect(services.sort()).toEqual(
        [
          "edgelambda.amazonaws.com",
          "events.amazonaws.com",
          "lambda.amazonaws.com",
          "rds.amazonaws.com",
          "scheduler.amazonaws.com",
        ].sort(),
      );
    });

    it("denies removing or replacing the boundary, changing the boundary policy, users, keys and the audit trail", () => {
      const denied = actionsOf(statements, "Deny");
      for (const a of [
        "iam:DeleteRolePermissionsBoundary",
        "iam:PutRolePermissionsBoundary",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "iam:CreateLoginProfile",
        "iam:AttachUserPolicy",
        "iam:*",
        "organizations:*",
        "account:*",
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "guardduty:Delete*",
        "sts:AssumeRole",
      ]) {
        expect(denied, `${file} ${a}`).toContain(a);
      }
      const other = statements.find((s) => s.Sid === "NeverAnotherBoundary");
      expect(other.Condition.StringNotEquals["iam:PermissionsBoundary"]).toEqual({
        "Fn::Sub": BOUNDARY_ARN,
      });
      const policy = statements.find((s) => s.Sid === "NeverChangeTheBoundaryPolicyItself");
      expect(resourceText(policy)).toContain("policy/TcCiRoleBoundary");
    });

    it("keeps the CI roles, the provider and users out of reach", () => {
      const deny = statements.find((s) => s.Sid === "NeverTheCiRolesNorTheProviderNorUsers");
      const text = resourceText(deny);
      expect(text).toContain("role/TcCi*");
      expect(text).toContain("oidc-provider/*");
      expect(text).toContain("user/*");
    });
  });

  it("the two deploy templates differ only by the role-name prefix, the trust and the comments", () => {
    const strip = (file) =>
      JSON.stringify(resources(tpl[file], "AWS::IAM::Role").map((r) => r.Properties.Policies))
        .replaceAll("role/tc-production-*", "role/tc-*")
        .replaceAll("role/ticon-cloud-production-*", "role/ticon-cloud-*");
    expect(strip("ci-deploy-production.yaml")).toBe(strip("ci-deploy-staging.yaml"));
    const boundary = (file) =>
      JSON.stringify(resources(tpl[file], "AWS::IAM::ManagedPolicy").map((p) => p.Properties));
    expect(boundary("ci-deploy-production.yaml")).toBe(boundary("ci-deploy-staging.yaml"));
  });
});

describe("the permissions boundary TcCiRoleBoundary", () => {
  describe.each(["ci-deploy-staging.yaml", "ci-deploy-production.yaml"])("%s", (file) => {
    const [boundary] = resources(tpl[file], "AWS::IAM::ManagedPolicy");
    const statements = expand(boundary.Properties.PolicyDocument.Statement);

    it("is the managed policy named TcCiRoleBoundary, defined in the same template", () => {
      expect(boundary.Properties.ManagedPolicyName).toBe("TcCiRoleBoundary");
      expect(resources(tpl[file], "AWS::IAM::ManagedPolicy")).toHaveLength(1);
    });

    it("allows no IAM, organization, account or audit action, and assumes only the pool and DNS roles", () => {
      for (const a of actionsOf(statements, "Allow")) {
        expect(a, file).not.toMatch(/^(iam|organizations|account|cloudtrail|guardduty):/);
        expect(a, file).not.toBe("*");
        if (a.startsWith("sts:")) expect(a, file).toBe("sts:AssumeRole");
      }
      const assume = statements.find((s) => s.Effect === "Allow" && s.Action === "sts:AssumeRole");
      expect(assume.Resource).toBe("arn:aws:iam::*:role/Tc*");
      const deny = actionsOf(statements, "Deny");
      expect(deny).toEqual(
        expect.arrayContaining(["iam:*", "organizations:*", "account:*", "cloudtrail:*"]),
      );
    });
  });
});

describe("plan role: minimal customer-managed read policy, no data-plane reads", () => {
  const file = "ci-plan-production.yaml";
  const [role] = rolesOf(file);
  const [policy] = resources(tpl[file], "AWS::IAM::ManagedPolicy");
  const statements = expand(policy.Properties.PolicyDocument.Statement);
  const allowed = actionsOf(statements, "Allow");
  const denied = actionsOf(statements, "Deny");

  it("attaches its own policy and no AWS managed policy (not ReadOnlyAccess)", () => {
    expect(role.Properties.ManagedPolicyArns).toEqual([{ Ref: "TcCiPlanReadPolicy" }]);
    expect(JSON.stringify(tpl[file].Resources)).not.toMatch(
      /aws:policy\/ReadOnlyAccess|arn:aws:iam::aws:policy/,
    );
    expect(role.Properties.Policies).toBeUndefined();
  });

  it("allows no data-plane read, no wildcard get or list, and no write", () => {
    for (const a of allowed) {
      expect(a, a).not.toMatch(/^(secretsmanager|rds-data|rds-db):/);
      expect(a, a).not.toMatch(/^logs:(GetLogEvents|FilterLogEvents|StartQuery|GetQueryResults)$/);
      expect(a, a).not.toMatch(/^dynamodb:(GetItem|Query|Scan|BatchGetItem)$/);
      expect(a, a).not.toBe("sqs:ReceiveMessage");
      expect(a, a).not.toBe("*");
      // only ec2:Describe* is a wildcard (network configuration of the VPC, no data)
      if (a !== "ec2:Describe*") expect(a, a).not.toMatch(/\*/);
      expect(a, a).not.toMatch(
        /:(Create|Put|Update|Delete|Attach|Detach|Tag|Untag|Start|Stop|Invoke)/,
      );
    }
  });

  it("limits object reads to the SST state bucket and parameter reads to the SST passphrase", () => {
    const objects = statements.find((s) => s.Sid === "TheSstStateBucketOnly");
    expect(list(objects.Resource).every((r) => r.startsWith("arn:aws:s3:::sst-state-"))).toBe(true);
    const params = statements.find((s) => s.Sid === "TheSstPassphraseAndBootstrapParameterOnly");
    for (const r of list(params.Resource)) expect(JSON.stringify(r)).toContain("parameter/sst/");
    expect(JSON.stringify(params.Resource)).not.toContain("parameter/*");
    const noObject = statements.find((s) => s.Sid === "NoObjectReadOutsideTheStateBucket");
    expect(noObject.NotResource).toBe("arn:aws:s3:::sst-state-*/*");
    const noParam = statements.find((s) => s.Sid === "NoParameterReadOutsideSst");
    expect(JSON.stringify(noParam.NotResource)).toContain("parameter/sst/*");
  });

  it("explicitly denies the data reads and every write that matters", () => {
    for (const a of [
      "s3:GetObject",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "secretsmanager:GetSecretValue",
      "kms:Decrypt",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "sqs:ReceiveMessage",
      "rds-data:*",
      "rds-db:connect",
      "iam:Create*",
      "iam:Put*",
      "organizations:*",
      "sts:AssumeRole",
    ]) {
      expect(denied, a).toContain(a);
    }
  });

  it("allows kms:Decrypt only on the state key, and denies it everywhere else", () => {
    const decryptAllow = statements.filter(
      (s) => s.Effect === "Allow" && list(s.Action).includes("kms:Decrypt"),
    );
    expect(decryptAllow).toHaveLength(1);
    expect(decryptAllow[0].Resource).toEqual({ Ref: "SstStateKeyArn" });
    const decryptDeny = statements.filter((s) => s.Effect === "Deny" && s.Action === "kms:Decrypt");
    expect(decryptDeny.some((s) => s.NotResource?.Ref === "SstStateKeyArn")).toBe(true);
    expect(decryptDeny.some((s) => s.Resource === "*")).toBe(true);
  });
});
