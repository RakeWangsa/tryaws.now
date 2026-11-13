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
    stage: "staging",
    other: "production",
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
    stage: "production",
    other: "staging",
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

  it("take the organisation, the repository and their numeric ids as parameters", () => {
    for (const { file } of ROLES) {
      const params = tpl[file].Parameters;
      expect(Object.keys(params), file).toEqual(
        expect.arrayContaining(["GitHubOrg", "GitHubOwnerId", "GitHubRepo", "GitHubRepoId"]),
      );
      expect(params.GitHubOwnerId.AllowedPattern, file).toBe("^[0-9]{1,20}$");
      expect(params.GitHubRepoId.AllowedPattern, file).toBe("^[0-9]{1,20}$");
      expect(params.GitHubOwnerId.Default, file).toBeUndefined();
      expect(params.GitHubRepoId.Default, file).toBeUndefined();
    }
  });

  // WPU-Z11: the GitHub OIDC provider may already exist in the account (one per account and URL). No
  // role template creates it, imports it or depends on the provider stack: each builds the ARN itself.
  it("do not need the stack of ci-oidc-provider.yaml (no import, no provider resource)", () => {
    for (const { file } of ROLES) {
      expect(text[file], file).not.toMatch(/Fn::ImportValue|ImportValue|DependsOn/);
      expect(resources(tpl[file], "AWS::IAM::OIDCProvider"), file).toEqual([]);
    }
    expect(text["ci-oidc-provider.yaml"]).toContain("list-open-id-connect-providers");
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

  // WPU-Z11 (VERIFY, GitHub OIDC reference "Immutable subject claims"): a repository created, renamed or
  // transferred after 2026-07-15 gets repo:OWNER@OWNER-ID/REPO@REPO-ID:... as its sub. job_workflow_ref
  // keeps the names.
  it("requires the audience, the immutable subject of the GitHub environment and the workflow reference", () => {
    const equals = statement.Condition.StringEquals;
    expect(equals[`${KEY}:aud`]).toBe("sts.amazonaws.com");
    expect(equals[`${KEY}:sub`]).toEqual({
      "Fn::Sub": `repo:\${GitHubOrg}@\${GitHubOwnerId}/\${GitHubRepo}@\${GitHubRepoId}:environment:${environment}`,
    });
    if (production) {
      const value = statement.Condition.StringLike?.[`${KEY}:job_workflow_ref`]["Fn::Sub"];
      expect(value).toBe(
        "${GitHubOrg}/${GitHubRepo}/.github/workflows/" + workflow + "@refs/tags/v*",
      );
    } else {
      // WPU-Z11 fix round 1: the staging role serves deploy-staging.yml and remove-staging.yml, each at the
      // protected branch, as two exact values under StringEquals (no wildcard).
      expect(equals[`${KEY}:job_workflow_ref`]).toEqual([
        {
          "Fn::Sub":
            "${GitHubOrg}/${GitHubRepo}/.github/workflows/deploy-staging.yml@refs/heads/${ProtectedBranch}",
        },
        {
          "Fn::Sub":
            "${GitHubOrg}/${GitHubRepo}/.github/workflows/remove-staging.yml@refs/heads/${ProtectedBranch}",
        },
      ]);
      expect(JSON.stringify(equals[`${KEY}:job_workflow_ref`])).not.toMatch(/\*|repo:/);
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
    const files = production ? [workflow] : [workflow, "remove-staging.yml"];
    for (const f of files) {
      const wf = read(join(root, ".github", "workflows", f));
      expect(wf, f).toMatch(new RegExp(`^\\s+environment:\\s+${environment}\\s*$`, "m"));
    }
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
const actionsOf = (statements, effect) =>
  statements.filter((s) => s.Effect === effect).flatMap((s) => list(s.Action));
const resourceText = (s) => JSON.stringify(s.Resource ?? s.NotResource ?? "");
const BOUNDARY = { staging: "TcCiRoleBoundaryStaging", production: "TcCiRoleBoundaryProduction" };
const boundaryArn = (stage) => `arn:aws:iam::\${AWS::AccountId}:policy/${BOUNDARY[stage]}`;

describe("deploy roles: no privilege escalation through IAM", () => {
  // WPU-Z11 (one account): each deploy role writes only the IAM names of its own stage.
  const files = [
    [
      "ci-deploy-staging.yaml",
      "staging",
      ["role/tc-staging-*", "role/tryaws-now-staging-*", "instance-profile/tc-staging-*"],
    ],
    [
      "ci-deploy-production.yaml",
      "production",
      ["role/tc-production-*", "role/tryaws-now-production-*", "instance-profile/tc-production-*"],
    ],
  ];

  describe.each(files)("%s", (file, stage, prefixes) => {
    const BOUNDARY_ARN = boundaryArn(stage);
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
      // WPU-Z11: the NAT instance role of a lean stage (SST vpc.ts) gets AmazonSSMManagedInstanceCore.
      expect(arns.sort()).toEqual(
        [
          "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        ].sort(),
      );
      const pass = allows.find((s) => s.Action === "iam:PassRole");
      const services = list(pass.Condition.StringEquals["iam:PassedToService"]);
      expect(services.sort()).toEqual(
        [
          "ec2.amazonaws.com",
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
      expect(resourceText(policy)).toContain(`policy/${BOUNDARY[stage]}"`);
    });

    // WPU-Z11 (VERIFY): SST's RdsRoleLookup (postgres.ts) reads the RDS service-linked role.
    it("may read the RDS service-linked role, with iam:GetRole only", () => {
      const s = allows.find((x) => x.Sid === "ReadTheRdsServiceLinkedRole");
      expect(s.Action).toBe("iam:GetRole");
      expect(s.Resource).toEqual({
        "Fn::Sub":
          "arn:aws:iam::${AWS::AccountId}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS",
      });
    });

    // WPU-Z11 (VERIFY): SST KvKeys and the budget of a lean stage.
    it("may change the CloudFront key value stores and only the budget of its own stage", () => {
      const kv = allows.find((x) => x.Sid === "KeyValueStoresOfTheSites");
      expect(list(kv.Action).sort()).toEqual([
        "cloudfront-keyvaluestore:DescribeKeyValueStore",
        "cloudfront-keyvaluestore:ListKeys",
        "cloudfront-keyvaluestore:UpdateKeys",
      ]);
      const budget = allows.find((x) => x.Sid === "BudgetOfTheStage");
      expect(list(budget.Action)).toEqual(
        expect.arrayContaining(["budgets:ModifyBudget", "budgets:ViewBudget"]),
      );
      expect(resourceText(budget)).toContain(`budget/tc-${stage}-*`);
    });

    // WPU-Z11: the NAT instance profile is named tc-<stage>-* by infra/app.ts (SST leaves it unnamed).
    it("manages instance profiles of its own stage only", () => {
      const s = allows.find((x) => x.Sid === "InstanceProfilesOfTheStage");
      expect(list(s.Action)).toEqual(
        expect.arrayContaining([
          "iam:CreateInstanceProfile",
          "iam:AddRoleToInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:GetInstanceProfile",
        ]),
      );
      expect(s.Resource).toEqual({
        "Fn::Sub": `arn:aws:iam::\${AWS::AccountId}:instance-profile/tc-${stage}-*`,
      });
    });

    it("keeps the CI roles, the provider and users out of reach", () => {
      const deny = statements.find((s) => s.Sid === "NeverTheCiRolesNorTheProviderNorUsers");
      const text = resourceText(deny);
      expect(text).toContain("role/TcCi*");
      expect(text).toContain("oidc-provider/*");
      expect(text).toContain("user/*");
    });
  });

  // Swapping the two stage names turns one template into the other, except the DNS-record limit that
  // only staging has (the production zone is the parent of the staging names).
  it("the two deploy templates differ only by the stage names, the trust and the staging DNS limit", () => {
    const swap = (value) =>
      value
        .replaceAll("production", "\u0000")
        .replaceAll("staging", "production")
        .replaceAll("\u0000", "staging")
        .replaceAll("Production", "\u0001")
        .replaceAll("Staging", "Production")
        .replaceAll("\u0001", "Staging");
    const policies = (file) => {
      const [role] = resources(tpl[file], "AWS::IAM::Role");
      return role.Properties.Policies.map((p) => ({
        ...p,
        PolicyDocument: {
          ...p.PolicyDocument,
          Statement: p.PolicyDocument.Statement.filter(
            (s) => s.Sid !== "OnlyTheDnsRecordsOfTheStage",
          ),
        },
      }));
    };
    expect(swap(JSON.stringify(policies("ci-deploy-production.yaml")))).toBe(
      JSON.stringify(policies("ci-deploy-staging.yaml")),
    );
    const boundary = (file) =>
      JSON.stringify(resources(tpl[file], "AWS::IAM::ManagedPolicy").map((p) => p.Properties));
    expect(swap(boundary("ci-deploy-production.yaml"))).toBe(boundary("ci-deploy-staging.yaml"));
  });
});

// WPU-Z11 (owner decision 2026-11-13): staging and production live in ONE account. Two stacks there must
// not create the same fixed name, and the staging deploy role must not change production.
describe("one account: fixed names are unique and each deploy role stays in its stage", () => {
  const ORG = ["ci-deploy-staging.yaml", "ci-plan-production.yaml", "ci-deploy-production.yaml"];
  const named = (file) => {
    const t = parse(read(join(root, "infra", "org", file)));
    return Object.values(t.Resources).flatMap((r) =>
      [r.Properties?.RoleName, r.Properties?.ManagedPolicyName].filter(
        (n) => typeof n === "string",
      ),
    );
  };

  it("no IAM name appears in two of the CI, pool or DNS templates", () => {
    const seen = new Map();
    for (const file of [...ORG, "pool-roles.yaml", "dns-account.yaml"]) {
      for (const n of named(file)) {
        // TcBillingReader exists in both pool-roles.yaml and dns-account.yaml; in one account the DNS
        // stack is deployed with CreateBillingReader=false (infra-org.test.mjs pins the condition).
        if (n === "TcBillingReader" && file === "dns-account.yaml") continue;
        expect(seen.get(n), `${n} in ${file} and ${seen.get(n)}`).toBeUndefined();
        seen.set(n, file);
      }
    }
    expect([...seen.keys()]).toEqual(
      expect.arrayContaining(["TcCiRoleBoundaryStaging", "TcCiRoleBoundaryProduction"]),
    );
    expect([...seen.keys()]).not.toContain("TcCiRoleBoundary");
  });

  describe.each(ROLES.filter((r) => r.other))("$name", ({ file, stage, other }) => {
    const statements = inlineStatements(file);
    const allows = statements.filter((s) => s.Effect === "Allow");

    it(`never names a resource of the ${other} stage in an Allow`, () => {
      for (const s of allows) expect(resourceText(s), s.Sid).not.toContain(other);
    });

    it(`denies every action on what SST tags or names for the ${other} stage`, () => {
      const tagged = statements.find((s) => s.Sid === "NeverWhatSstTaggedForTheOtherStage");
      expect(tagged).toMatchObject({ Effect: "Deny", Action: "*", Resource: "*" });
      expect(tagged.Condition).toEqual({ StringEquals: { "aws:ResourceTag/sst:stage": other } });
      const created = statements.find((s) => s.Sid === "NeverCreateForTheOtherStage");
      expect(created.Condition).toEqual({ StringEquals: { "aws:RequestTag/sst:stage": other } });
      const names = statements.find((s) => s.Sid === "NeverANameOfTheOtherStage");
      expect(names).toMatchObject({ Effect: "Deny", Action: "*" });
      const text = resourceText(names);
      for (const part of [
        `role/tc-${other}-*`,
        `role/tryaws-now-${other}-*`,
        `function:tc-${other}-*`,
        `function:tryaws-now-${other}-*`,
        `parameter/sst/passphrase/tryaws-now/${other}`,
        `sst-state-*/*/tryaws-now/${other}*`,
        `budget/tc-${other}-*`,
      ]) {
        expect(text, part).toContain(part);
      }
      expect(text).not.toContain(`-${stage}-`);
    });

    // WPU-Z11 fix round 1: CloudFront Functions and the WAF of the other stage, by name.
    it(`denies the CloudFront Functions and the WAF of the ${other} stage by name`, () => {
      const text = resourceText(statements.find((s) => s.Sid === "NeverANameOfTheOtherStage"));
      for (const part of [
        `cloudfront::\${AWS::AccountId}:function/tryaws-now-${other}-*`,
        `cloudfront::\${AWS::AccountId}:function/*-${other}-*`,
        `:*/webacl/tc-${other}-*`,
        `:*/ipset/tc-${other}-*`,
      ]) {
        expect(text, part).toContain(part);
      }
    });

    // WPU-Z11 fix round 1: the SST bootstrap is shared by both stages; neither deploy role may change it.
    it("never changes the shared SST bootstrap parameter or the SST state and asset buckets", () => {
      const param = statements.find((s) => s.Sid === "NeverTheSharedSstBootstrap");
      expect(param.Effect).toBe("Deny");
      expect(list(param.Action)).toEqual(
        expect.arrayContaining([
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:DeleteParameters",
          "ssm:LabelParameterVersion",
          "ssm:AddTagsToResource",
        ]),
      );
      expect(param.Resource).toEqual({
        "Fn::Sub": "arn:aws:ssm:*:${AWS::AccountId}:parameter/sst/bootstrap",
      });
      const buckets = statements.find((s) => s.Sid === "NeverTheSharedSstBuckets");
      expect(buckets.Effect).toBe("Deny");
      expect(list(buckets.Action)).toEqual(
        expect.arrayContaining([
          "s3:PutBucket*",
          "s3:DeleteBucket*",
          "s3:PutLifecycleConfiguration",
          "s3:PutEncryptionConfiguration",
          "s3:PutReplicationConfiguration",
        ]),
      );
      // bucket-level actions only: objects (state files, assets) stay usable
      for (const a of list(buckets.Action)) expect(a).not.toMatch(/Object/);
      expect(buckets.Resource).toEqual(["arn:aws:s3:::sst-state-*", "arn:aws:s3:::sst-asset-*"]);
    });

    // WPU-Z11 fix round 2: the name-based object denies cannot be bypassed through an S3 access point.
    it("may neither create nor use an S3 access point", () => {
      const create = statements.find((s) => s.Sid === "NeverCreateAnS3AccessPoint");
      expect(create).toMatchObject({ Effect: "Deny", Resource: "*" });
      expect(list(create.Action).sort()).toEqual([
        "s3:CreateAccessPoint",
        "s3:CreateAccessPointForObjectLambda",
        "s3:CreateMultiRegionAccessPoint",
      ]);
      const use = statements.find((s) => s.Sid === "NeverUseAnS3AccessPoint");
      expect(use).toMatchObject({ Effect: "Deny", Action: "s3:*", Resource: "*" });
      expect(use.Condition).toEqual({ Null: { "s3:DataAccessPointArn": "false" } });
    });

    it("names the shared SST asset bucket and the response headers policy as known residuals", () => {
      const text = readFileSync(join(root, "infra", "org", file), "utf8");
      expect(text).toContain("(4) the shared SST asset bucket sst-asset-*");
      expect(text).toContain("tc-<stage>-security-headers");
      expect(text).not.toContain("objects stay usable");
    });
  });

  // WPU-Z11 (security review): a role CREATED by one stage (it carries that stage's boundary) cannot read
  // or change the data, secrets or functions of the other stage in the shared account.
  describe.each(ROLES.filter((r) => r.other))("boundary of $name", ({ file, stage, other }) => {
    const [boundary] = resources(tpl[file], "AWS::IAM::ManagedPolicy");
    const statements = expand(boundary.Properties.PolicyDocument.Statement);

    it(`denies every action on what SST tags sst:stage=${other}`, () => {
      const s = statements.find((x) => x.Sid === "NeverWhatSstTaggedForTheOtherStage");
      expect(s).toMatchObject({ Effect: "Deny", Action: "*", Resource: "*" });
      expect(s.Condition).toEqual({ StringEquals: { "aws:ResourceTag/sst:stage": other } });
    });

    it(`denies every action on the ${other} secrets, parameters, state, data and functions by name`, () => {
      const s = statements.find((x) => x.Sid === "NeverANameOfTheOtherStage");
      expect(s).toMatchObject({ Effect: "Deny", Action: "*" });
      const text = resourceText(s);
      for (const part of [
        `arn:aws:s3:::tryaws-now-${other}-*`,
        `sst-state-*/*/tryaws-now/${other}*`,
        `parameter/sst/passphrase/tryaws-now/${other}"`,
        `parameter/sst/tryaws-now/${other}/*`,
        `secret:tryaws-now-${other}-*`,
        `table/tryaws-now-${other}-*`,
        `:tryaws-now-${other}-*`,
        `function:tc-${other}-*`,
        `function:tryaws-now-${other}-*`,
        `alias/tc-${other}-*`,
      ]) {
        expect(text, part).toContain(part);
      }
      expect(text).not.toContain(`-${stage}-`);
      expect(text).not.toContain(`/${stage}`);
    });
  });

  it("the staging role changes only the DNS records of the two staging names", () => {
    const s = inlineStatements("ci-deploy-staging.yaml").find(
      (x) => x.Sid === "OnlyTheDnsRecordsOfTheStage",
    );
    expect(s).toMatchObject({ Effect: "Deny", Action: "route53:ChangeResourceRecordSets" });
    expect(
      s.Condition["ForAnyValue:StringNotLike"][
        "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      ],
    ).toEqual([
      { Ref: "WebDomain" },
      { "Fn::Sub": "*.${WebDomain}" },
      { Ref: "AdminDomain" },
      { "Fn::Sub": "*.${AdminDomain}" },
    ]);
  });
});

describe("the permissions boundaries TcCiRoleBoundaryStaging and TcCiRoleBoundaryProduction", () => {
  describe.each([
    ["ci-deploy-staging.yaml", "staging"],
    ["ci-deploy-production.yaml", "production"],
  ])("%s", (file, stage) => {
    const [boundary] = resources(tpl[file], "AWS::IAM::ManagedPolicy");
    const statements = expand(boundary.Properties.PolicyDocument.Statement);

    it("is the managed policy of its stage, defined in the same template", () => {
      expect(boundary.Properties.ManagedPolicyName).toBe(BOUNDARY[stage]);
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
    const bucket = statements.find((s) => s.Sid === "TheSstStateBucketOnly");
    expect(bucket.Action).toBe("s3:ListBucket");
    expect(bucket.Resource).toBe("arn:aws:s3:::sst-state-*");
    // WPU-Z11 fix round 1: objects of the production stage only (the bucket is shared with staging).
    const objects = statements.find((s) => s.Sid === "TheProductionStateObjectsOnly");
    expect(objects.Action).toBe("s3:GetObject");
    expect(objects.Resource).toBe("arn:aws:s3:::sst-state-*/*/tryaws-now/production*");
    const params = statements.find((s) => s.Sid === "TheSstPassphraseAndBootstrapParameterOnly");
    for (const r of list(params.Resource)) expect(JSON.stringify(r)).toContain("parameter/sst/");
    expect(JSON.stringify(params.Resource)).not.toContain("parameter/*");
    const noObject = statements.find((s) => s.Sid === "NoObjectReadOutsideTheStateBucket");
    expect(noObject.NotResource).toBe("arn:aws:s3:::sst-state-*/*/tryaws-now/production*");
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

  // WPU-Z11 (VERIFY, Parameter Store "Restricting access"): reading the SecureString passphrase needs
  // kms:Decrypt of the caller on aws/ssm. Both Deny branches exempt exactly that decryption, by the
  // encryption context PARAMETER_ARN of the production passphrase (not staging's, in one account).
  it("exempts only the decryption of the production SST passphrase from the kms:Decrypt deny", () => {
    const passphrase =
      "arn:aws:ssm:*:${AWS::AccountId}:parameter/sst/passphrase/tryaws-now/production";
    const decryptDeny = statements.filter((s) => s.Effect === "Deny" && s.Action === "kms:Decrypt");
    expect(decryptDeny).toHaveLength(2);
    for (const s of decryptDeny) {
      expect(s.Condition).toEqual({
        StringNotLike: { "kms:EncryptionContext:PARAMETER_ARN": { "Fn::Sub": passphrase } },
      });
    }
    const params = statements.find((s) => s.Sid === "TheSstPassphraseAndBootstrapParameterOnly");
    expect(params.Resource).toEqual([
      { "Fn::Sub": passphrase },
      { "Fn::Sub": "arn:aws:ssm:*:${AWS::AccountId}:parameter/sst/bootstrap" },
    ]);
  });
});
