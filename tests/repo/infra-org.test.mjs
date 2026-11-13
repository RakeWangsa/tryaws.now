import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { FUNCTIONS } from "../../infra/lib/functions.ts";
import { roleName as sstRole } from "../../infra/lib/stage.ts";
import { describe, expect, it } from "vitest";

// WP0-T5: static proof of the templates in infra/org. Nothing here talks to AWS and nothing proves that
// AWS accepts a template: the README lists what DevOps confirms. The checks read the YAML as data
// (the templates use the long form of the intrinsic functions, so a plain YAML parser reads them).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const orgDir = join(root, "infra", "org");
const read = (path) => readFileSync(path, "utf8");
const load = (name) => parse(read(join(orgDir, name)));

const TEMPLATES = [
  "accounts-and-ous.yaml",
  "scps.yaml",
  "pool-roles.yaml",
  "dns-account.yaml",
  "cloudtrail-log-bucket.yaml",
  "cloudtrail-trail.yaml",
  "guardduty.yaml",
];
const tpl = Object.fromEntries(TEMPLATES.map((name) => [name, load(name)]));
const files = readdirSync(orgDir).filter((n) => statSync(join(orgDir, n)).isFile());

const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const resourcesOf = (t, type) =>
  Object.entries(t.Resources)
    .filter(([, r]) => r.Type === type)
    .map(([id, r]) => ({ id, ...r }));
const statementsOf = (doc) => list(doc.Statement);
const actionsOf = (s) => list(s.Action);
const allowActions = (doc) =>
  statementsOf(doc)
    .filter((s) => s.Effect === "Allow")
    .flatMap(actionsOf);
const denyActions = (doc) =>
  statementsOf(doc)
    .filter((s) => s.Effect === "Deny")
    .flatMap(actionsOf);
const rolePolicyDocs = (role) => list(role.Properties.Policies).map((p) => p.PolicyDocument);
const roleByName = (t, name) =>
  resourcesOf(t, "AWS::IAM::Role").find((r) => r.Properties.RoleName === name);

// ---- trust policy checks -----------------------------------------------------------------------

/** Names ("${X}" and Ref) used in a value. */
function referencedNames(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([A-Za-z0-9:]+)\}/g)) out.push(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "Ref") out.push(x);
        else walk(x);
      }
    }
  };
  walk(value);
  return out;
}

/** What is wrong with the trust policy of a role; an empty list means nothing found. */
function trustProblems(role, template) {
  const problems = [];
  const trust = role.Properties.AssumeRolePolicyDocument;
  const params = Object.keys(template.Parameters ?? {});
  for (const s of statementsOf(trust)) {
    const principal = s.Principal;
    if (principal === "*" || principal?.AWS === "*" || list(principal?.AWS).includes("*")) {
      problems.push("wildcard principal");
    }
    if (principal?.Service !== undefined || principal?.Federated !== undefined) {
      problems.push("principal is not an AWS account");
    }
    if (s.Effect !== "Allow") problems.push("trust statement is not an Allow");
    if (!list(s.Action).every((a) => a === "sts:AssumeRole"))
      problems.push("action is not sts:AssumeRole");
    const cond = s.Condition ?? {};
    if (cond.ArnEquals?.["aws:PrincipalArn"] === undefined)
      problems.push("no aws:PrincipalArn condition");
    if (cond.StringEquals?.["sts:ExternalId"] === undefined)
      problems.push("no sts:ExternalId condition");
    for (const name of referencedNames(s)) {
      if (!params.includes(name))
        problems.push(`trust refers to ${name}, which is not a parameter`);
    }
    // No literal account in an ARN: every ARN in a trust statement is built from a parameter.
    const text = JSON.stringify(s);
    if (/arn:aws:iam::[0-9]/.test(text)) problems.push("literal account in an ARN");
  }
  return problems;
}

function resolve(value, params) {
  if (typeof value === "string") return value;
  if (value?.Ref !== undefined) return params[value.Ref];
  if (value?.["Fn::Sub"] !== undefined) {
    return value["Fn::Sub"].replace(/\$\{([A-Za-z0-9:]+)\}/g, (_, n) => params[n]);
  }
  throw new Error(`cannot resolve ${JSON.stringify(value)}`);
}

/** A small model of sts:AssumeRole against the trust policy: principal, aws:PrincipalArn, ExternalId. */
function mayAssume(role, params, { callerArn, externalId }) {
  const callerAccount = /^arn:aws:iam::([0-9]{12}):/.exec(callerArn)?.[1];
  return statementsOf(role.Properties.AssumeRolePolicyDocument).some((s) => {
    if (s.Effect !== "Allow") return false;
    const principals = list(s.Principal.AWS).map((p) => resolve(p, params));
    const principalOk = principals.some(
      (p) => p === callerArn || p === `arn:aws:iam::${callerAccount}:root`,
    );
    const arns = list(s.Condition.ArnEquals["aws:PrincipalArn"]).map((v) => resolve(v, params));
    const idWanted = resolve(s.Condition.StringEquals["sts:ExternalId"], params);
    return principalOk && arns.includes(callerArn) && externalId === idWanted;
  });
}

const defaultsOf = (t) =>
  Object.fromEntries(
    Object.entries(t.Parameters)
      .filter(([, p]) => p.Default !== undefined)
      .map(([k, p]) => [k, String(p.Default)]),
  );

const STG = "222222222222"; // made-up value for the model only
const PROD = "111111111111";
const EXTERNAL_ID = "test-external-id-0001";

describe("the templates parse", () => {
  it("every template is CloudFormation YAML with parameters and resources", () => {
    for (const name of TEMPLATES) {
      const t = tpl[name];
      expect(t.AWSTemplateFormatVersion, name).toBe("2010-09-09");
      expect(Object.keys(t.Resources).length, name).toBeGreaterThan(0);
    }
  });

  it("no CloudFormation short-form tag is used (a plain YAML parser must read every template)", () => {
    for (const name of TEMPLATES) {
      expect(read(join(orgDir, name)), name).not.toMatch(
        /^\s*[^#\n]*:\s+!(Ref|Sub|GetAtt|Join|If)\b/m,
      );
    }
  });
});

describe("no account, secret or contact in the folder", () => {
  it("has no 12-digit number, no account ARN, no access key id, no email address", () => {
    for (const name of files) {
      const text = read(join(orgDir, name));
      expect(text, name).not.toMatch(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9])/);
      expect(text, name).not.toMatch(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]{6,}/);
      expect(text, name).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{12,}/);
      expect(text, name).not.toMatch(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });
});

describe("trust policies", () => {
  const trustTemplates = ["pool-roles.yaml", "dns-account.yaml"];
  const roles = trustTemplates.flatMap((n) =>
    resourcesOf(tpl[n], "AWS::IAM::Role").map((r) => ({ file: n, role: r })),
  );

  it("exist for the roles of Section 6.3", () => {
    expect(roles.map((r) => r.role.Properties.RoleName).sort()).toEqual([
      "TcAccessDetails",
      "TcBillingReader",
      "TcBillingReader",
      "TcDnsProvisioner",
      "TcDnsReader",
      "TcProvisioner",
      "TcReader",
    ]);
  });

  it("trust a named function role of the control plane account, with an ExternalId, and only parameters", () => {
    for (const { file, role } of roles) {
      expect(trustProblems(role, tpl[file]), `${file} ${role.Properties.RoleName}`).toEqual([]);
    }
  });

  it("the check itself catches a wildcard principal, a missing condition and a literal account", () => {
    const bad = {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" }],
        },
      },
    };
    expect(trustProblems(bad, { Parameters: {} })).toEqual(
      expect.arrayContaining([
        "wildcard principal",
        "no aws:PrincipalArn condition",
        "no sts:ExternalId condition",
      ]),
    );
    const literal = JSON.parse(JSON.stringify(roleByName(tpl["pool-roles.yaml"], "TcProvisioner")));
    literal.Properties.AssumeRolePolicyDocument.Statement[0].Principal.AWS =
      "arn:aws:iam::999999999999:root";
    expect(trustProblems(literal, tpl["pool-roles.yaml"])).toContain("literal account in an ARN");
  });

  it("the web and admin function roles are not a parameter, a default or a word of any trust policy", () => {
    for (const { file, role } of roles) {
      const trustText = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      expect(trustText, `${file} ${role.Properties.RoleName}`).not.toMatch(/web|admin/i);
      for (const name of referencedNames(role.Properties.AssumeRolePolicyDocument)) {
        const param = tpl[file].Parameters[name];
        if (param?.Default !== undefined)
          expect(String(param.Default), name).not.toMatch(/web|admin/i);
      }
    }
    for (const name of ["pool-roles.yaml", "dns-account.yaml"]) {
      for (const key of Object.keys(tpl[name].Parameters)) expect(key).not.toMatch(/web|admin/i);
    }
  });

  describe("model of sts:AssumeRole for tc-pool-dev (control plane = tc-platform-stg)", () => {
    const t = tpl["pool-roles.yaml"];
    const params = {
      ...defaultsOf(t),
      ControlPlaneAccountId: STG,
      ControlPlaneStage: "staging",
      ExternalId: EXTERNAL_ID,
    };
    const fn = (account, name) => `arn:aws:iam::${account}:role/${name}`;
    const asks = (roleName, callerArn, externalId = EXTERNAL_ID) =>
      mayAssume(roleByName(t, roleName), params, { callerArn, externalId });

    it("the staging provisioner function role can assume TcProvisioner with the ExternalId", () => {
      expect(asks("TcProvisioner", fn(STG, sstRole("staging", "provisioner")))).toBe(true);
    });

    it("the staging web role cannot assume TcProvisioner, nor any other Tc role", () => {
      for (const webName of [
        sstRole("staging", "web"),
        sstRole("staging", "admin"),
        "tc-fn-web",
        "tc-web",
        "tc-fn-admin",
        "tc-admin",
      ]) {
        for (const r of ["TcProvisioner", "TcReader", "TcAccessDetails", "TcBillingReader"]) {
          expect(asks(r, fn(STG, webName)), `${webName} -> ${r}`).toBe(false);
        }
        // not even with the right ExternalId, and not with a made-up one
        expect(asks("TcProvisioner", fn(STG, webName), "anything")).toBe(false);
      }
    });

    it("the right function role fails without the ExternalId, with a wrong one, and from another account", () => {
      const caller = fn(STG, sstRole("staging", "provisioner"));
      expect(asks("TcProvisioner", caller, null)).toBe(false);
      expect(asks("TcProvisioner", caller, "wrong")).toBe(false);
      expect(asks("TcProvisioner", fn(PROD, sstRole("staging", "provisioner")))).toBe(false);
    });

    it("each function role reaches only its own roles", () => {
      const reach = (name) =>
        ["TcProvisioner", "TcReader", "TcAccessDetails", "TcBillingReader"].filter((r) =>
          asks(r, fn(STG, name)),
        );
      expect(reach(sstRole("staging", "provisioner"))).toEqual(["TcProvisioner"]);
      expect(reach(sstRole("staging", "reader"))).toEqual(["TcReader"]);
      expect(reach(sstRole("staging", "catalog-sync"))).toEqual(["TcReader"]);
      expect(reach(sstRole("staging", "reconciler"))).toEqual(["TcReader", "TcBillingReader"]);
      expect(reach(sstRole("staging", "access-details"))).toEqual(["TcAccessDetails"]);
    });
  });

  describe("model of sts:AssumeRole for tc-dns", () => {
    const t = tpl["dns-account.yaml"];
    const params = { ...defaultsOf(t), ControlPlaneAccountId: PROD, ExternalId: EXTERNAL_ID };
    const fn = (account, name) => `arn:aws:iam::${account}:role/${name}`;
    it("only the provisioner function role of tc-platform assumes TcDnsProvisioner", () => {
      const may = (name, account = PROD) =>
        mayAssume(roleByName(t, "TcDnsProvisioner"), params, {
          callerArn: fn(account, name),
          externalId: EXTERNAL_ID,
        });
      expect(may("tc-production-provisioner-role")).toBe(true);
      expect(may("tc-production-web-role")).toBe(false);
      expect(may("tc-production-admin-role")).toBe(false);
      expect(may("tc-production-provisioner-role", STG)).toBe(false);
    });
  });

  // C.3: the trust names the roles that SST really creates (infra/lib/stage.ts roleName is what
  // infra/stacks/workers.ts passes to transform.role), for every function of the function table.
  describe("the role names of SST (tc-<stage>-<function>-role) are the ones the trust names", () => {
    const pool = tpl["pool-roles.yaml"];
    const dns = tpl["dns-account.yaml"];
    const arn = (account, name) => `arn:aws:iam::${account}:role/${name}`;
    const reachable = (stage, dir) => {
      const base = {
        ControlPlaneAccountId: PROD,
        ExternalId: EXTERNAL_ID,
        ControlPlaneStage: stage,
      };
      const callerArn = arn(PROD, sstRole(stage, dir));
      const names = [];
      for (const t of [pool, dns]) {
        for (const role of resourcesOf(t, "AWS::IAM::Role")) {
          const params = { ...defaultsOf(t), ...base };
          if (mayAssume(role, params, { callerArn, externalId: EXTERNAL_ID })) {
            names.push(`${role.Properties.RoleName}`);
          }
        }
      }
      return names.sort();
    };

    it("each function reaches exactly the roles of the function table, for staging and production", () => {
      for (const stage of ["staging", "production"]) {
        for (const spec of FUNCTIONS) {
          const wanted = [...new Set(spec.poolRoles)].sort();
          const got = reachable(stage, spec.dir);
          // TcBillingReader exists in the pool template and in tc-dns: one name, two accounts
          expect([...new Set(got)], `${stage} ${spec.dir}`).toEqual(wanted);
        }
      }
    });

    it("web and admin reach nothing, and a role of the other stage reaches nothing", () => {
      for (const stage of ["staging", "production"]) {
        expect(reachable(stage, "web"), stage).toEqual([]);
        expect(reachable(stage, "admin"), stage).toEqual([]);
      }
      const other = {
        ControlPlaneAccountId: PROD,
        ExternalId: EXTERNAL_ID,
        ControlPlaneStage: "staging",
      };
      const role = roleByName(pool, "TcProvisioner");
      expect(
        mayAssume(
          role,
          { ...other },
          {
            callerArn: arn(PROD, sstRole("production", "provisioner")),
            externalId: EXTERNAL_ID,
          },
        ),
      ).toBe(false);
    });

    it("no template keeps the old tc-fn-* names or their parameters", () => {
      for (const name of ["pool-roles.yaml", "dns-account.yaml"]) {
        expect(read(join(orgDir, name)), name).not.toMatch(/tc-fn-|FunctionRoleName/);
      }
    });
  });
});

describe("permissions", () => {
  const poolRoles = resourcesOf(tpl["pool-roles.yaml"], "AWS::IAM::Role");
  const dnsRoles = resourcesOf(tpl["dns-account.yaml"], "AWS::IAM::Role");

  it("every role has a permissions boundary that the same template defines", () => {
    for (const [file, roles] of [
      ["pool-roles.yaml", poolRoles],
      ["dns-account.yaml", dnsRoles],
    ]) {
      const boundaries = resourcesOf(tpl[file], "AWS::IAM::ManagedPolicy");
      expect(boundaries.length, file).toBe(1);
      for (const role of roles) {
        expect(role.Properties.PermissionsBoundary, `${file} ${role.Properties.RoleName}`).toEqual({
          Ref: boundaries[0].id,
        });
      }
    }
  });

  it("session duration is one hour", () => {
    for (const [file, roles] of [
      ["pool-roles.yaml", poolRoles],
      ["dns-account.yaml", dnsRoles],
    ]) {
      expect(tpl[file].Parameters.MaxSessionSeconds.MaxValue).toBe(3600);
      for (const role of roles)
        expect(role.Properties.MaxSessionDuration).toEqual({ Ref: "MaxSessionSeconds" });
    }
  });

  it("no template allows creating an IAM user or an access key, and the boundaries deny IAM", () => {
    for (const name of TEMPLATES) {
      const docs = [];
      const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === "object") {
          if (v.Statement !== undefined) docs.push(v);
          Object.values(v).forEach(walk);
        }
      };
      walk(tpl[name].Resources);
      for (const doc of docs) {
        for (const s of statementsOf(doc)) {
          if (s.Effect !== "Allow") continue;
          for (const a of actionsOf(s)) {
            expect(a, `${name}: ${s.Sid}`).not.toMatch(
              /^(\*|iam:\*|iam:Create(User|AccessKey|LoginProfile)|iam:Update(LoginProfile))$/,
            );
          }
        }
      }
    }
    for (const file of ["pool-roles.yaml", "dns-account.yaml"]) {
      const [boundary] = resourcesOf(tpl[file], "AWS::IAM::ManagedPolicy");
      expect(denyActions(boundary.Properties.PolicyDocument)).toContain("iam:*");
    }
  });

  it("no identity policy allows lightsail:*; only the boundary ceiling does", () => {
    for (const role of poolRoles) {
      for (const doc of rolePolicyDocs(role))
        expect(allowActions(doc)).not.toContain("lightsail:*");
    }
    const [boundary] = resourcesOf(tpl["pool-roles.yaml"], "AWS::IAM::ManagedPolicy");
    expect(allowActions(boundary.Properties.PolicyDocument)).toContain("lightsail:*");
  });

  const NEVER = [
    "lightsail:DownloadDefaultKeyPair",
    "lightsail:PeerVpc",
    "lightsail:UnpeerVpc",
    "lightsail:ExportSnapshot",
    "lightsail:CreateCloudFormationStack",
  ];

  it("TcProvisioner explicitly denies the six actions of 6.3 and allows no secret-returning action", () => {
    const role = roleByName(tpl["pool-roles.yaml"], "TcProvisioner");
    const [doc] = rolePolicyDocs(role);
    expect(denyActions(doc).sort()).toEqual(
      [...NEVER, "lightsail:GetInstanceAccessDetails"].sort(),
    );
    const allowed = allowActions(doc);
    for (const a of [
      ...NEVER,
      "lightsail:GetInstanceAccessDetails",
      "lightsail:GetRelationalDatabaseMasterUserPassword",
      "lightsail:CreateBucketAccessKey",
    ]) {
      expect(allowed).not.toContain(a);
    }
    expect(allowed).toContain("lightsail:TagResource");
    const [boundary] = resourcesOf(tpl["pool-roles.yaml"], "AWS::IAM::ManagedPolicy");
    expect(denyActions(boundary.Properties.PolicyDocument)).toEqual(expect.arrayContaining(NEVER));
  });

  it("TcReader is Get* only, with the three secret-returning actions denied", () => {
    const role = roleByName(tpl["pool-roles.yaml"], "TcReader");
    const [doc] = rolePolicyDocs(role);
    expect(allowActions(doc)).toEqual(["lightsail:Get*"]);
    expect(denyActions(doc).sort()).toEqual(
      [
        "lightsail:DownloadDefaultKeyPair",
        "lightsail:GetInstanceAccessDetails",
        "lightsail:GetRelationalDatabaseMasterUserPassword",
      ].sort(),
    );
  });

  it("TcAccessDetails: the Windows password only for instances tagged tc:os=windows (allow and deny), nothing else", () => {
    const role = roleByName(tpl["pool-roles.yaml"], "TcAccessDetails");
    const [doc] = rolePolicyDocs(role);
    expect(allowActions(doc).sort()).toEqual(
      [
        "lightsail:CreateBucketAccessKey",
        "lightsail:GetBucketAccessKeys",
        "lightsail:GetInstanceAccessDetails",
        "lightsail:GetRelationalDatabaseMasterUserPassword",
      ].sort(),
    );
    const accessAllow = statementsOf(doc).find(
      (s) => s.Effect === "Allow" && actionsOf(s).includes("lightsail:GetInstanceAccessDetails"),
    );
    expect(accessAllow.Condition).toEqual({ StringEquals: { "aws:ResourceTag/tc:os": "windows" } });
    expect(accessAllow.Resource["Fn::Sub"]).toMatch(/:Instance\/\*$/);
    const accessDeny = statementsOf(doc).find(
      (s) => s.Effect === "Deny" && actionsOf(s).includes("lightsail:GetInstanceAccessDetails"),
    );
    expect(accessDeny.Condition).toEqual({
      StringNotEquals: { "aws:ResourceTag/tc:os": "windows" },
    });
  });

  it("TcBillingReader allows ce:GetCostAndUsage and nothing else (pool accounts and tc-dns)", () => {
    for (const roles of [poolRoles, dnsRoles]) {
      const role = roles.find((r) => r.Properties.RoleName === "TcBillingReader");
      const docs = rolePolicyDocs(role);
      expect(docs.flatMap(allowActions)).toEqual(["ce:GetCostAndUsage"]);
    }
  });

  it("TcDnsReader has exactly the actions of 6.3 (plus ListHostedZones listed there)", () => {
    const role = roleByName(tpl["dns-account.yaml"], "TcDnsReader");
    expect(rolePolicyDocs(role).flatMap(allowActions).sort()).toEqual(
      [
        "route53domains:CheckDomainAvailability",
        "route53domains:GetDomainSuggestions",
        "route53domains:ListPrices",
        "route53domains:GetDomainDetail",
        "route53domains:GetContactReachabilityStatus",
        "route53domains:ListDomains",
        "route53:ListHostedZones",
        "route53:GetHostedZone",
        "route53:ListResourceRecordSets",
      ].sort(),
    );
  });

  it("TcDnsProvisioner has no wildcard action, no transfer and no delete of a domain", () => {
    const role = roleByName(tpl["dns-account.yaml"], "TcDnsProvisioner");
    const allowed = rolePolicyDocs(role).flatMap(allowActions);
    for (const a of allowed) expect(a).not.toMatch(/\*/);
    expect(allowed.filter((a) => /Transfer|DeleteDomain|AuthCode/.test(a))).toEqual([]);
    expect(allowed).toEqual(
      expect.arrayContaining(["route53domains:RegisterDomain", "route53:ChangeResourceRecordSets"]),
    );
  });

  it("WPU-D4: TcDnsProvisioner allows exactly the hosted zone calls of the Route 53 client, in us-east-1 only", () => {
    const role = roleByName(tpl["dns-account.yaml"], "TcDnsProvisioner");
    const statement = rolePolicyDocs(role)
      .flatMap(statementsOf)
      .find((s) => s.Sid === "HostedZonesAndRecords");
    expect(statement.Effect).toBe("Allow");
    expect(list(statement.Action).sort()).toEqual(
      [
        "route53:ChangeResourceRecordSets",
        "route53:CreateHostedZone",
        "route53:DeleteHostedZone",
        "route53:GetChange",
        "route53:GetHostedZone",
        "route53:ListHostedZonesByName",
        "route53:ListResourceRecordSets",
      ].sort(),
    );
    expect(statement.Condition).toEqual({ StringEquals: { "aws:RequestedRegion": "us-east-1" } });
    // the reader of tc-dns can never write a zone
    const reader = roleByName(tpl["dns-account.yaml"], "TcDnsReader");
    const readerRoute53 = rolePolicyDocs(reader)
      .flatMap(allowActions)
      .filter((a) => a.startsWith("route53:"));
    expect(readerRoute53.filter((a) => /Create|Change|Delete/.test(a))).toEqual([]);
  });

  it("every Allow of a Lightsail or Route 53 role is limited to the approved Regions", () => {
    const check = (roles, regions) => {
      for (const role of roles) {
        for (const doc of rolePolicyDocs(role)) {
          for (const s of statementsOf(doc).filter((x) => x.Effect === "Allow")) {
            if (actionsOf(s).some((a) => a.startsWith("ce:"))) continue;
            const region = s.Condition?.StringEquals?.["aws:RequestedRegion"];
            if (region !== undefined) {
              expect(list(region).sort(), s.Sid).toEqual(regions);
            } else {
              // Windows password, database password and bucket key: the resource ARN carries the account.
              expect(JSON.stringify(s.Resource), s.Sid).toContain("AWS::AccountId");
            }
          }
        }
      }
    };
    check(poolRoles, ["ap-south-1", "ap-southeast-1", "us-east-1"]);
    check(dnsRoles, ["us-east-1"]);
  });
});

describe("the allow-lists match the adapters of packages/aws", () => {
  const awsDir = join(root, "packages", "aws");
  const commandsOf = (file) => {
    const src = read(join(awsDir, file));
    const names = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@aws-sdk\/client-lightsail"/g)) {
      for (const n of m[1].split(",")) {
        const name = n.trim();
        if (/^[A-Z][A-Za-z0-9]+Command$/.test(name))
          names.add(`lightsail:${name.replace(/Command$/, "")}`);
      }
    }
    return names;
  };
  const adapters = readdirSync(join(awsDir, "adapters"))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => `adapters/${n}`);
  const accessFiles = [
    "adapters/bucket-access.ts",
    "adapters/database-access.ts",
    "adapters/windows-access.ts",
  ];
  const readFiles = ["reader-source.ts", "catalog.ts"];

  it("finds the adapters (the test would pass on an empty list otherwise)", () => {
    expect(adapters.length).toBeGreaterThan(10);
    expect(accessFiles.every((f) => adapters.includes(f))).toBe(true);
    expect([...commandsOf("adapters/linux-instance.ts")].length).toBeGreaterThan(10);
  });

  it("TcProvisioner allows exactly the commands of the provisioning adapters, plus TagResource", () => {
    const used = new Set();
    for (const f of adapters.filter((x) => !accessFiles.includes(x))) {
      for (const c of commandsOf(f)) used.add(c);
    }
    const role = roleByName(tpl["pool-roles.yaml"], "TcProvisioner");
    const allowed = new Set(rolePolicyDocs(role).flatMap(allowActions));
    allowed.delete("lightsail:TagResource");
    expect([...allowed].sort()).toEqual([...used].sort());
  });

  it("TcAccessDetails allows the commands of the access adapters", () => {
    const used = new Set(accessFiles.flatMap((f) => [...commandsOf(f)]));
    const role = roleByName(tpl["pool-roles.yaml"], "TcAccessDetails");
    const allowed = new Set(rolePolicyDocs(role).flatMap(allowActions));
    for (const c of used) expect(allowed, c).toContain(c);
  });

  it("TcReader (Get*) covers the commands of the reader source and the catalog", () => {
    for (const f of readFiles) {
      for (const c of commandsOf(f)) expect(c, f).toMatch(/^lightsail:Get/);
    }
  });
});

describe("service control policies", () => {
  const t = tpl["scps.yaml"];
  const policy = (id) => t.Resources[id].Properties;
  const guard = policy("GuardrailsPolicy").Content;
  const pool = policy("PoolAllowListPolicy").Content;
  const dns = policy("DnsAllowListPolicy").Content;
  const sid = (doc, name) => statementsOf(doc).find((s) => s.Sid === name);

  it("are service control policies with targets", () => {
    for (const id of ["GuardrailsPolicy", "PoolAllowListPolicy", "DnsAllowListPolicy"]) {
      expect(t.Resources[id].Type).toBe("AWS::Organizations::Policy");
      expect(policy(id).Type).toBe("SERVICE_CONTROL_POLICY");
      expect(policy(id).TargetIds).toBeDefined();
      expect(JSON.stringify(policy(id).Content).length, id).toBeLessThan(5120);
    }
  });

  it("deny leaving the organization", () => {
    const s = sid(guard, "DenyLeavingTheOrganization");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toContain("organizations:LeaveOrganization");
  });

  it("deny disabling CloudTrail, GuardDuty and Config", () => {
    const s = sid(guard, "DenyDisablingAuditServices");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toEqual(
      expect.arrayContaining([
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromAdministratorAccount",
        "config:StopConfigurationRecorder",
        "config:DeleteConfigurationRecorder",
        "config:DeleteDeliveryChannel",
      ]),
    );
  });

  it("deny every Region but the three of the spec (global services stay out of the NotAction)", () => {
    const s = sid(guard, "DenyRegionsThatAreNotApproved");
    expect(s.Effect).toBe("Deny");
    expect(s.Condition.StringNotEquals["aws:RequestedRegion"].sort()).toEqual([
      "ap-south-1",
      "ap-southeast-1",
      "us-east-1",
    ]);
    expect(s.NotAction).toEqual(
      expect.arrayContaining(["iam:*", "sts:*", "route53:*", "route53domains:*", "cloudfront:*"]),
    );
    expect(s.NotAction).not.toContain("lightsail:*");
  });

  it("deny IAM users and access keys (R3)", () => {
    const s = sid(guard, "DenyLongLivedKeysAndPasswords");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toEqual(expect.arrayContaining(["iam:CreateUser", "iam:CreateAccessKey"]));
  });

  it("deny every action of the root user of a member account", () => {
    const s = sid(guard, "DenyRootUserActions");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toBe("*");
    expect(s.Condition.ArnLike["aws:PrincipalArn"]).toBe("arn:aws:iam::*:root");
  });

  it("protect the SCPs themselves", () => {
    const s = sid(guard, "ProtectTheServiceControlPolicies");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toEqual(
      expect.arrayContaining([
        "organizations:AttachPolicy",
        "organizations:DetachPolicy",
        "organizations:UpdatePolicy",
        "organizations:DeletePolicy",
        "organizations:DisablePolicyType",
      ]),
    );
  });

  it("the guardrails have no Allow statement (they cannot widen anything)", () => {
    for (const doc of [guard, pool, dns]) {
      expect(statementsOf(doc).every((s) => s.Effect === "Deny")).toBe(true);
    }
  });

  it("the pool SCP denies everything but Lightsail and the read-only and support actions", () => {
    const s = sid(pool, "DenyEverythingExceptLightsailAndSupport");
    expect(s.NotAction).toContain("lightsail:*");
    expect(s.NotAction).toContain("ce:GetCostAndUsage");
    expect(s.NotAction).toContain("servicequotas:*");
    expect(s.NotAction).toContain("support:*");
    expect(
      s.NotAction.filter((a) => /^(ec2|s3|rds|lambda|route53|route53domains|kms):/.test(a)),
    ).toEqual([]);
  });

  it("the DNS SCP allows only Route 53 and Route 53 Domains (and the same minimum)", () => {
    const s = sid(dns, "DenyEverythingExceptRoute53AndSupport");
    expect(s.NotAction).toEqual(
      expect.arrayContaining(["route53:*", "route53domains:*", "ce:GetCostAndUsage"]),
    );
    expect(s.NotAction.filter((a) => /^(ec2|s3|rds|lambda|lightsail):/.test(a))).toEqual([]);
  });

  it("the pool and DNS SCPs protect the Tc roles from everyone but the named admin role", () => {
    for (const doc of [pool, dns]) {
      const s = sid(doc, "ProtectTheTcRoles");
      expect(s.Effect).toBe("Deny");
      expect(s.Resource).toBe("arn:aws:iam::*:role/Tc*");
      expect(s.Action).toEqual(
        expect.arrayContaining([
          "iam:PutRolePolicy",
          "iam:UpdateAssumeRolePolicy",
          "iam:DeleteRole",
        ]),
      );
      expect(Object.keys(s.Condition)).toEqual(["ArnNotLike"]);
    }
  });
});

describe("organization trail, log bucket and GuardDuty", () => {
  it("the trail is an organization trail with validation, KMS and all Regions", () => {
    const [trail] = resourcesOf(tpl["cloudtrail-trail.yaml"], "AWS::CloudTrail::Trail");
    expect(trail.Properties).toMatchObject({
      IsOrganizationTrail: true,
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
      IncludeGlobalServiceEvents: true,
      IsLogging: true,
    });
    expect(trail.Properties.KMSKeyId).toBeDefined();
  });

  it("the log bucket is private, versioned, locked, encrypted with the key, and nobody can delete from it", () => {
    const t = tpl["cloudtrail-log-bucket.yaml"];
    const [bucket] = resourcesOf(t, "AWS::S3::Bucket");
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.VersioningConfiguration.Status).toBe("Enabled");
    expect(bucket.Properties.ObjectLockEnabled).toBe(true);
    expect(
      bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
        .ServerSideEncryptionByDefault.SSEAlgorithm,
    ).toBe("aws:kms");
    const [policy] = resourcesOf(t, "AWS::S3::BucketPolicy");
    const everyone = statementsOf(policy.Properties.PolicyDocument).find(
      (s) => s.Sid === "DenyDeleteToEveryoneIncludingAdmins",
    );
    expect(everyone).toMatchObject({ Effect: "Deny", Principal: "*" });
    expect(everyone.Condition).toBeUndefined();
    expect(everyone.Action).toEqual(["s3:DeleteObject", "s3:DeleteObjectVersion"]);
    const tls = statementsOf(policy.Properties.PolicyDocument).find(
      (s) => s.Sid === "DenyPlainHttp",
    );
    expect(tls.Condition).toEqual({ Bool: { "aws:SecureTransport": "false" } });
    // Only the CloudTrail service may write.
    const allows = statementsOf(policy.Properties.PolicyDocument).filter(
      (s) => s.Effect === "Allow",
    );
    for (const s of allows) expect(s.Principal).toEqual({ Service: "cloudtrail.amazonaws.com" });
    const [key] = resourcesOf(t, "AWS::KMS::Key");
    expect(key.Properties.EnableKeyRotation).toBe(true);
    expect(key.DeletionPolicy).toBe("Retain");
  });

  it("GuardDuty is enabled and findings of high severity reach on-call", () => {
    const t = tpl["guardduty.yaml"];
    const [detector] = resourcesOf(t, "AWS::GuardDuty::Detector");
    expect(detector.Properties.Enable).toBe(true);
    const [rule] = resourcesOf(t, "AWS::Events::Rule");
    expect(rule.Properties.EventPattern.source).toEqual(["aws.guardduty"]);
    expect(rule.Properties.State).toBe("ENABLED");
  });
});

describe("OUs, alternate contacts, isolation plan and the DevOps README", () => {
  it("six OUs: security, prod, staging, dns, pools, pools-dev", () => {
    const names = resourcesOf(
      tpl["accounts-and-ous.yaml"],
      "AWS::Organizations::OrganizationalUnit",
    )
      .map((r) => r.Properties.Name)
      .sort();
    expect(names).toEqual([
      "TiCON-Dns",
      "TiCON-Platform-Prod",
      "TiCON-Platform-Staging",
      "TiCON-Pools",
      "TiCON-Pools-Dev",
      "TiCON-Security",
    ]);
  });

  it("the alternate contact script is a dry run unless --apply, sets only SECURITY, and prints no contact detail", () => {
    const sh = read(join(orgDir, "alternate-contacts.template.sh"));
    expect(sh).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(sh).toContain('mode="dry-run"');
    expect(sh).toMatch(/\[ "\$\{1:-\}" = "--apply" \]/);
    expect(sh).toContain("--alternate-contact-type SECURITY");
    expect(sh).not.toMatch(/alternate-contact-type (BILLING|OPERATIONS)/);
    expect(sh).toContain("set -euo pipefail");
    // No echo of the email or phone number.
    expect(sh).not.toMatch(/echo[^\n]*(EMAIL|PHONE|account_id)/);
  });

  it("the isolation plan is marked MANUAL and names the code and the test", () => {
    const md = read(join(orgDir, "ISOLATION.md"));
    expect(md).toContain("MANUAL");
    expect(md).toContain("tc-pool-dev");
    expect(md).toContain("packages/aws/adapters/bootstrap.ts");
    expect(md).toContain("tests/isolation");
  });

  it("the README keeps the confirmation column empty (only DevOps fills it) and lists the order", () => {
    const md = read(join(orgDir, "README.md"));
    const [, table] = md.split("## Needs DevOps confirmation");
    const rows = table
      .split("\n")
      .filter((l) => l.startsWith("|") && !/^\|\s*(-|Statement)/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1);
      expect(cells.length, row).toBe(2);
      expect(cells[1].trim(), row).toBe("");
    }
    expect(md).toContain("## Order of application");
    for (const f of files.filter((n) => n !== "README.md")) expect(md, f).toContain(f);
  });

  it("the onboarding runbook points at the templates", () => {
    const md = read(join(root, "docs", "runbooks", "pool-account-onboarding.md"));
    expect(md).toContain("infra/org/");
    expect(md).toContain("pool-roles.yaml");
  });

  it("keeps the VERIFY comments (none was dropped silently)", () => {
    let count = 0;
    for (const name of files) {
      count += (read(join(orgDir, name)).match(/VERIFY:/g) ?? []).length;
    }
    expect(count).toBeGreaterThanOrEqual(20);
  });
});

describe("security review rules (WP0-T5 review)", () => {
  const scp = tpl["scps.yaml"];
  const content = (id) => scp.Resources[id].Properties.Content;
  const sid = (doc, name) => statementsOf(doc).find((s) => s.Sid === name);
  const bucketTpl = tpl["cloudtrail-log-bucket.yaml"];
  const [bucketPolicy] = resourcesOf(bucketTpl, "AWS::S3::BucketPolicy");
  const bucketDoc = bucketPolicy.Properties.PolicyDocument;

  it("log bucket: Object Lock is COMPLIANCE and nobody may bypass, shorten or hold retention", () => {
    const [bucket] = resourcesOf(bucketTpl, "AWS::S3::Bucket");
    expect(bucket.Properties.ObjectLockConfiguration.Rule.DefaultRetention.Mode).toBe("COMPLIANCE");
    const s = sid(bucketDoc, "DenyRetentionTamperingToEveryone");
    expect(s).toMatchObject({ Effect: "Deny", Principal: "*" });
    expect(s.Condition).toBeUndefined();
    expect(s.Action).toEqual(
      expect.arrayContaining([
        "s3:BypassGovernanceRetention",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold",
      ]),
    );
  });

  it("log bucket: only the CloudTrail service may write under AWSLogs/ (no overwrite or injection)", () => {
    const s = sid(bucketDoc, "DenyWritesExceptByTheCloudTrailService");
    expect(s.Effect).toBe("Deny");
    expect(s.Action).toEqual(["s3:PutObject"]);
    expect(s.Resource["Fn::Sub"]).toMatch(/\/AWSLogs\/\*$/);
    expect(s.Condition).toEqual({
      StringNotEquals: { "aws:PrincipalServiceName": "cloudtrail.amazonaws.com" },
    });
  });

  it("trail key: administered only by the named admin role parameter, not by the account root", () => {
    const [key] = resourcesOf(bucketTpl, "AWS::KMS::Key");
    const admin = statementsOf(key.Properties.KeyPolicy).find((s) => /Administration/.test(s.Sid));
    expect(admin.Condition).toEqual({
      ArnLike: { "aws:PrincipalArn": { Ref: "KeyAdminRoleArnPattern" } },
    });
    expect(bucketTpl.Parameters.KeyAdminRoleArnPattern).toBeDefined();
  });

  it("SCP ticon-log-protection denies policy, Object Lock and key tampering with no principal exemption on the bucket", () => {
    const doc = content("LogProtectionPolicy");
    const b = sid(doc, "ProtectTheLogBucketPolicyAndObjectLock");
    expect(b.Effect).toBe("Deny");
    expect(b.Condition).toBeUndefined();
    expect(b.Action).toEqual(
      expect.arrayContaining([
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutBucketObjectLockConfiguration",
      ]),
    );
    const k = sid(doc, "ProtectTheTrailKey");
    expect(k.Action).toEqual(
      expect.arrayContaining(["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"]),
    );
    expect(Object.keys(k.Condition)).toEqual(["ArnNotLike"]);
  });

  it("SCP: no StackSet exemption anywhere", () => {
    expect(JSON.stringify(scp)).not.toMatch(/StackSetRole|StackSetExecution/);
    expect(scp.Parameters.StackSetRoleArnPattern).toBeUndefined();
  });

  it("SCP pool and DNS: admin-type actions only for the admin role, roles only with the boundary", () => {
    for (const [id, boundary] of [
      ["PoolAllowListPolicy", "TcPoolPermissionsBoundary"],
      ["DnsAllowListPolicy", "TcDnsPermissionsBoundary"],
    ]) {
      const doc = content(id);
      const a = sid(doc, "DenyAdminActionsExceptForTheAdminRole");
      expect(a.Effect).toBe("Deny");
      for (const x of ["iam:*", "servicequotas:*", "support:*", "cloudformation:*"])
        expect(a.NotAction).not.toContain(x);
      expect(a.Condition.ArnNotLike["aws:PrincipalArn"]).toEqual([{ Ref: "AdminRoleArnPattern" }]);
      const r = sid(doc, "DenyRolesWithoutTheBoundary");
      expect(r.Action).toEqual(["iam:CreateRole", "iam:PutRolePermissionsBoundary"]);
      expect(r.Condition.StringNotLike["iam:PermissionsBoundary"]).toBe(
        `arn:aws:iam::*:policy/${boundary}`,
      );
    }
  });

  it("SCP: the audit-service denies are complete", () => {
    const s = sid(content("GuardrailsPolicy"), "DenyDisablingAuditServices");
    expect(s.Action).toEqual(
      expect.arrayContaining([
        "guardduty:CreateFilter",
        "guardduty:UpdateFilter",
        "guardduty:DeleteFilter",
        "guardduty:DeletePublishingDestination",
        "guardduty:UpdateMalwareScanSettings",
        "config:DeleteConfigRule",
        "config:DeleteRetentionConfiguration",
        "config:DeleteEvaluationResults",
        "cloudtrail:DeleteEventDataStore",
      ]),
    );
  });

  it("SCP: leaving the organization and root user actions are denied at the organization root too", () => {
    const p = scp.Resources.RootGuardrailsPolicy.Properties;
    expect(p.TargetIds).toEqual([{ Ref: "RootId" }]);
    expect(sid(p.Content, "DenyLeavingTheOrganization").Action).toContain(
      "organizations:LeaveOrganization",
    );
    expect(sid(p.Content, "DenyRootUserActions").Condition.ArnLike["aws:PrincipalArn"]).toBe(
      "arn:aws:iam::*:root",
    );
    expect(JSON.stringify(p.Content).length).toBeLessThan(5120);
  });

  it("TcProvisioner: UpdateBucket and UpdateDistribution only on resources tagged by the platform; the residual risk is written down", () => {
    const role = roleByName(tpl["pool-roles.yaml"], "TcProvisioner");
    const [doc] = rolePolicyDocs(role);
    const s = statementsOf(doc).find((x) => actionsOf(x).includes("lightsail:UpdateBucket"));
    expect(actionsOf(s).sort()).toEqual([
      "lightsail:AttachCertificateToDistribution",
      "lightsail:DetachCertificateFromDistribution",
      "lightsail:UpdateBucket",
      "lightsail:UpdateDistribution",
      "lightsail:UpdateDistributionBundle",
    ]);
    expect(s.Condition.Null).toEqual({ "aws:ResourceTag/tc:resource": "false" });
    expect(s.Resource).not.toContain("*");
    const text = read(join(orgDir, "pool-roles.yaml"));
    expect(text).toContain("packages/aws/adapters/bucket.ts");
    expect(text).toContain("packages/aws/adapters/cdn.ts");
  });
});

// Found by the owner's first `aws cloudformation validate-template` (2026-11-13): AWS rejects a
// template whose Description is longer than 1024 characters (ci-deploy-staging and ci-deploy-production
// had 1270 and 1342). Long notes belong in comments. Every .yaml file in this folder is checked.
describe("CloudFormation limits that the owner's first validation found", () => {
  const yamlFiles = files.filter((n) => n.endsWith(".yaml"));
  it.each(yamlFiles)("%s: the Description has at most 1024 bytes", (name) => {
    const doc = load(name);
    expect(typeof doc.Description, `${name} Description`).toBe("string");
    expect(Buffer.byteLength(doc.Description, "utf8")).toBeLessThanOrEqual(1024);
  });
});
