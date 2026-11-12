// WP0-T2, WP0-T3, WP0-T4: the rules of the SST app, proven by reading the source text of
// infra/stacks (SST is not installed here, so the declarations cannot run). A real deploy output
// is a manual step (JOURNEY.md). Comments are removed before any check, so a comment cannot
// satisfy or break a rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function source(file) {
  const text = readFileSync(resolve(root, file), "utf8");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .replace(/,\s*([\]})])/g, "$1");
}

const network = source("infra/stacks/network.ts");
const waf = source("infra/stacks/waf.ts");
const web = source("infra/stacks/web.ts");
const database = source("infra/stacks/database.ts");
const auth = source("infra/stacks/auth.ts");
const messaging = source("infra/stacks/messaging.ts");
const storage = source("infra/stacks/storage.ts");
const alarms = source("infra/stacks/alarms.ts");
const workers = source("infra/stacks/workers.ts");
const secrets = source("infra/stacks/secrets.ts");
const config = source("infra/sst.config.ts");

// The text of one `new sst.aws.<Kind>("<Name>", { ... })` call up to the next sibling call.
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = endMarker === undefined ? text.length : text.indexOf(endMarker, start + 1);
  return text.slice(start, end === -1 ? text.length : end);
}

describe("WP0-T2: stages, VPC, CloudFront, WAF", () => {
  it("guards the stage before anything is declared", () => {
    expect(config).toMatch(/app\(input\)[\s\S]*assertDeployAllowed\(stage, process\.env\)/);
    expect(config).toContain("readStageConfig($app.stage, process.env)");
    expect(config).toMatch(/protect: stageKind\(stage\) === "production"/);
    expect(config).toContain('home: "aws"');
    expect(config).toContain("providers: { aws: { region: REGION } }");
  });

  it("builds a VPC with two AZs and a managed NAT", () => {
    expect(network).toMatch(
      /new sst\.aws\.Vpc\("Vpc",\s*\{[\s\S]*az: AZ_COUNT[\s\S]*nat: "managed"/,
    );
  });

  it("keeps invoice-renderer isolated: no NAT route, HTTPS to S3 through a gateway endpoint", () => {
    expect(network).toContain('vpcEndpointType: "Gateway"');
    expect(network).toContain("com.amazonaws.${REGION}.s3");
    const isolatedGroup = between(
      network,
      'new aws.ec2.SecurityGroup("IsolatedSecurityGroup"',
      "return {",
    );
    expect(isolatedGroup).toContain("fromPort: 443");
    expect(isolatedGroup).toContain("prefixListIds");
    expect(isolatedGroup).not.toContain("0.0.0.0/0");
    const routeTable = between(
      network,
      'new aws.ec2.RouteTable("IsolatedRouteTable"',
      "new aws.ec2.VpcEndpoint",
    );
    expect(routeTable).not.toMatch(/natGatewayId|gatewayId|0\.0\.0\.0/);
  });

  it("puts both apps behind CloudFront with OAC and edge signing, so a direct function URL request gets 403", () => {
    expect([...web.matchAll(/new sst\.aws\.Nextjs\(/g)]).toHaveLength(2);
    expect([...web.matchAll(/protection: "oac-with-edge-signing"/g)]).toHaveLength(2);
    for (const text of [web, workers, auth, storage, messaging]) {
      expect(text).not.toMatch(/protection: "(none|oac)"/);
      expect(text).not.toMatch(/authorization: "none"/);
    }
    // no worker is given a function URL
    expect(workers).not.toMatch(/\burl:/);
  });

  it("attaches the web ACLs through transform.cdn webAclArn", () => {
    expect(web).toContain("args.webAclArn = aclArn");
    expect(web).toContain("cdn: cdnTransform(waf.customerAclArn, waf.securityHeadersPolicyId)");
    expect(web).toContain("cdn: cdnTransform(waf.adminAclArn, waf.securityHeadersPolicyId)");
  });

  it("creates the web ACLs in us-east-1 with the three managed groups and the rate rules", () => {
    expect(waf).toContain('new aws.Provider("EdgeProvider", { region: EDGE_REGION })');
    expect(waf).toContain("EDGE_REGION");
    expect([...waf.matchAll(/scope: "CLOUDFRONT"/g)].length).toBeGreaterThanOrEqual(4);
    for (const group of [
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesAmazonIpReputationList",
    ]) {
      expect(waf).toContain(`"${group}"`);
    }
    for (const path of [
      '"/login"',
      '"/signup"',
      '"/verify"',
      '"/wallet"',
      '"/orders"',
      '"/pay/eps/"',
    ]) {
      expect(waf).toContain(`contains: ${path}`);
    }
    expect(waf).toContain('searchString: "POST"');
    expect(waf).toContain("rateBasedStatement");
  });

  it("restricts the admin ACL to the allowlist and fails closed on a bad list", () => {
    expect(waf).toContain("parseAllowlist(config.adminAllowlist)");
    expect(waf).toMatch(/block-outside-allowlist[\s\S]*notStatement[\s\S]*ipSetReferenceStatement/);
    expect(waf).toMatch(/priority: 0,\s*action: \{ block: \{\} \}/);
    expect(web).toContain("ADMIN_IP_ALLOWLIST: config.adminAllowlist");
  });

  it("sets HSTS in the CloudFront response headers policy, not in application code", () => {
    expect(waf).toContain("aws.cloudfront.ResponseHeadersPolicy");
    expect(waf).toContain("strictTransportSecurity");
    expect(waf).toMatch(/accessControlMaxAgeSec: 63072000/);
    expect(waf).toContain("includeSubdomains: true");
    expect(web).toContain("responseHeadersPolicyId");
  });

  it("never turns on a fake switch and sets TC_STAGE from the stage", () => {
    for (const text of [config, web, workers, auth, database]) {
      expect(text).not.toMatch(/TC_(EPS|IDP|SMS)/);
    }
    expect(web.match(/TC_STAGE: config\.tcStage/g)).toHaveLength(2);
    expect(workers).toContain("TC_STAGE: config.tcStage");
  });
});

describe("R1: the web tier cannot assume pool roles", () => {
  it("has no sts permission in web.ts at all", () => {
    expect(web).not.toMatch(/sts:/i);
    expect(web).not.toMatch(/AssumeRole/);
  });

  it("allows sts:AssumeRole only in workers.ts, from the poolRoles of the function table", () => {
    for (const [name, text] of Object.entries({
      network,
      waf,
      web,
      database,
      auth,
      messaging,
      storage,
      alarms,
      secrets,
      config,
    })) {
      expect(text, name).not.toMatch(/AssumeRole/);
    }
    const hits = [...workers.matchAll(/sts:AssumeRole/g)];
    expect(hits).toHaveLength(1);
    expect(workers).toMatch(
      /const roles = \[\.\.\.new Set\(spec\.poolRoles\)\];\s*if \(roles\.length > 0\)/,
    );
    expect(workers).toContain("assumableRoleArns(role, config)");
  });

  it("gives neither app a wildcard permission", () => {
    expect(web).not.toMatch(/resources: \["\*"\]/);
    expect([...web.matchAll(/"[a-z0-9-]+:[A-Za-z]*\*[A-Za-z*]*"/g)].map((m) => m[0])).toEqual([]);
  });

  it("lists the specific Cognito admin actions of the admin pool, and not the dangerous ones", () => {
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    const actions = [...admin.matchAll(/"cognito-idp:([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    expect(actions).toEqual([
      "AdminCreateUser",
      "AdminDisableUser",
      "AdminEnableUser",
      "AdminGetUser",
      "AdminSetUserMFAPreference",
      "ListUsers",
    ]);
    expect(admin).toContain("resources: [auth.admins.arn]");
    for (const forbidden of [
      "AdminSetUserPassword",
      "AdminResetUserPassword",
      "AdminUserGlobalSignOut",
      "AdminUpdateUserAttributes",
    ]) {
      expect(admin).not.toContain(forbidden);
    }
    // the customer app may only sign out its own pool's users
    const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');
    expect([...customer.matchAll(/"cognito-idp:([A-Za-z]+)"/g)].map((m) => m[1])).toEqual([
      "AdminUserGlobalSignOut",
    ]);
    expect(customer).toContain("resources: [auth.customers.arn]");
  });
});

describe("WAF rate rules and Server Actions", () => {
  it("keeps the page rules on POST + path, with no Next-Action requirement", () => {
    expect(waf).toMatch(
      /rateRule\(rule\.name, firstPriority \+ index, rule\.limit, \[isPost, pathContains\(rule\.contains\)\]\)/,
    );
    const pageRule = /rateRule\(rule\.name[^;]*?\]\)/.exec(waf)?.[0] ?? "";
    expect(pageRule).not.toMatch(/hasNextAction|next-action/i);
  });

  it("limits, per IP, any POST with Next-Action or a form content type (OR of three conditions)", () => {
    expect(waf).toContain('fieldToMatch: { singleHeader: { name: "next-action" } }');
    expect(waf).toMatch(/comparisonOperator: "GT", size: 0/);
    expect(waf).toMatch(
      /rateRule\("server-actions", [^,]+, SERVER_ACTION_LIMIT, \[ isPost, \{ orStatement: \{ statements: \[hasNextAction, isMultipartForm, isUrlEncodedForm\] \} \}\]\)/,
    );
    expect(waf).toContain('contentTypeContains("multipart/form-data")');
    expect(waf).toContain('contentTypeContains("application/x-www-form-urlencoded")');
    expect(waf).toMatch(
      /fieldToMatch: \{ singleHeader: \{ name: "content-type" \} \}, positionalConstraint: "CONTAINS", textTransformations: \[\{ priority: 0, type: "LOWERCASE" \}\]/,
    );
    expect(waf).toContain('aggregateKeyType: "IP"');
  });

  it("decodes before lowercasing in every uriPath match", () => {
    expect([...waf.matchAll(/uriPath: \{\}/g)]).toHaveLength(1);
    expect(waf).toContain(
      'const decodeThenLowercase = [ { priority: 0, type: "URL_DECODE" }, { priority: 1, type: "LOWERCASE" }];',
    );
    expect(waf).toMatch(
      /fieldToMatch: \{ uriPath: \{\} \}, positionalConstraint: "CONTAINS", textTransformations: decodeThenLowercase/,
    );
    expect(waf).not.toMatch(
      /uriPath: \{\}, positionalConstraint: "CONTAINS", textTransformations: \[ \{ priority: 0, type: "LOWERCASE"/,
    );
  });

  it("counts the EPS return routes (GET redirects) without a method condition", () => {
    expect(waf).toContain(
      'const EPS_RETURN = { name: "eps-return", contains: "/pay/eps/", limit: 300 }',
    );
    expect(waf).toMatch(
      /rateRule\(EPS_RETURN\.name, [^)]*EPS_RETURN\.limit, \[ pathContains\(EPS_RETURN\.contains\)\]\)/,
    );
  });
});

describe("Cognito attribute writes", () => {
  it("requires verification before an e-mail update in both pools", () => {
    expect([
      ...auth.matchAll(
        /args\.userAttributeUpdateSettings = \{ attributesRequireVerificationBeforeUpdate: \["email"\] \}/g,
      ),
    ]).toHaveLength(2);
  });

  it("gives the clients an explicit writeAttributes allowlist without e-mail or phone", () => {
    expect(auth).toContain('args.writeAttributes = ["name"]');
    expect(auth).toContain("args.writeAttributes = []");
    const lists = [...auth.matchAll(/args\.writeAttributes = (\[[^\]]*\])/g)].map((m) => m[1]);
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).not.toMatch(/email|phone|custom:/);
    // the comment records why: users are identified by sub, not by e-mail
    expect(readFileSync(resolve(root, "infra/stacks/auth.ts"), "utf8")).toContain(
      "customers.cognito_sub",
    );
  });
});

describe("WP0-T3: database, proxy and roles", () => {
  const instance = between(database, "instance: (args", "parameterGroup:");

  it("keeps the instance private, protected, backed up 14 days, encrypted, with a final snapshot (R2)", () => {
    expect(instance).toContain("args.publiclyAccessible = false");
    expect(instance).toContain("args.deletionProtection = true");
    expect(instance).toContain("args.backupRetentionPeriod = 14");
    expect(instance).toContain("args.storageEncrypted = true");
    expect(instance).toContain("args.kmsKeyId = key.arn");
    expect(instance).toContain("args.skipFinalSnapshot = false");
    expect(instance).toContain("args.vpcSecurityGroupIds = [net.databaseSecurityGroup.id]");
    expect(database).not.toMatch(
      /publiclyAccessible = true|deletionProtection = false|skipFinalSnapshot = true/,
    );
  });

  it("forces TLS on the instance and on the proxy", () => {
    expect(database).toMatch(/name: "rds\.force_ssl", value: "1"/);
    expect(database).toContain("args.requireTls = true");
    expect(database).toContain("args.vpcSecurityGroupIds = [net.proxySecurityGroup.id]");
    expect(database).toContain("multiAz: production");
  });

  it("admits 5432 only from the previous hop", () => {
    for (const rule of ["ProxyFromApp", "ProxyToDatabase", "DatabaseFromProxy"]) {
      expect(network).toContain(`"${rule}"`);
    }
    expect(
      between(network, 'new aws.vpc.SecurityGroupIngressRule("DatabaseFromProxy"', "});"),
    ).toContain("referencedSecurityGroupId: proxySecurityGroup.id");
    expect(network.match(/egress: egressAll/g)).toHaveLength(1);
    const databaseGroup = between(
      network,
      'new aws.ec2.SecurityGroup("DatabaseSecurityGroup"',
      'new aws.vpc.SecurityGroupIngressRule("ProxyFromApp"',
    );
    expect(databaseGroup).not.toMatch(/ingress|egress|cidr/i);
  });

  it("lists the four proxy roles and creates no password in code", () => {
    expect(database).toContain("PROXY_ROLES.map");
    expect(database).toContain("password: secrets.db[role].value");
    for (const [name, text] of Object.entries({ database, workers, secrets, auth, web, config })) {
      expect(text, name).not.toMatch(
        /CREATE ROLE|ALTER ROLE|PASSWORD '|RandomPassword|password: "/i,
      );
    }
  });

  it("links the Postgres component and all five passwords to the migrator only", () => {
    expect(workers).toMatch(
      /spec\.dbRole === "migrator"[\s\S]*links\.push\(db\.postgres, \.\.\.DB_ROLES\.map/,
    );
    expect([...workers.matchAll(/db\.postgres/g)]).toHaveLength(1);
    for (const [name, text] of Object.entries({ web, auth, alarms, messaging, storage })) {
      expect(text, name).not.toMatch(/\bpostgres\b/);
    }
    expect(web).not.toMatch(/link: \[[^\]]*\bpostgres\b/);
    // the web function links only its own role password
    const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');
    expect(customer).toContain("secrets.db.web_rw");
    expect(customer).not.toMatch(/secrets\.db\.(admin_rw|worker_rw|migrator|report_ro)/);
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    expect(admin).toContain("link: [secrets.db.admin_rw]");
  });

  it("runs the migrator at deploy time, in the VPC", () => {
    expect(workers).toContain('new sst.aws.Function("Migrator"');
    expect(workers).toContain('new aws.lambda.Invocation("MigratorRun"');
  });

  it("uses the function table for handler paths and links secrets only from it", () => {
    expect(workers).toContain("handler: `functions/${spec.dir}/index.${spec.handlerExport}`");
    expect(workers).toContain("spec.secrets.map((name) => secrets.app[name])");
    expect(workers).toContain('if (spec.dbRole === "worker_rw") links.push(secrets.db.worker_rw)');
  });

  it("keeps all declared secrets without values", () => {
    expect(secrets).toContain("new sst.Secret(name)");
    expect(secrets).not.toMatch(/new sst\.Secret\(\w+,/);
  });
});

describe("WP0-T4: identity, queue, buckets, alarms", () => {
  const customers = between(
    auth,
    'new sst.aws.CognitoUserPool("CustomerPool"',
    "const customerClient",
  );
  const admins = between(auth, 'new sst.aws.CognitoUserPool("AdminPool"', "const adminClient");

  it("requires TOTP for admins and allows no self sign-up", () => {
    expect(admins).toContain('mfa: "on"');
    expect(admins).toContain("softwareToken: true");
    expect(admins).toContain("allowAdminCreateUserOnly: true");
    expect(admins).not.toContain("allowAdminCreateUserOnly: false");
    expect(admins).not.toMatch(/\bsms\b/);
  });

  it("keeps admin sessions at 8 hours", () => {
    expect(auth).toContain("args.refreshTokenValidity = 8");
    expect(auth).toContain('refreshToken: "hours"');
  });

  it("lets customers sign up, with optional TOTP and a 12 character password", () => {
    expect(customers).toContain('mfa: "optional"');
    expect(customers).toContain("allowAdminCreateUserOnly: false");
    expect(auth).toContain("minimumLength: 12");
  });

  it("sends e-mail of both pools through SES", () => {
    expect(auth).toContain('emailSendingAccount: "DEVELOPER"');
    expect(auth).toContain("sourceArn: config.sesIdentityArn");
    expect([...auth.matchAll(/args\.emailConfiguration = email/g)]).toHaveLength(2);
  });

  it("uses one custom-message function for both pools, outside the VPC, with no links", () => {
    expect([...auth.matchAll(/customMessage: messages\.arn/g)]).toHaveLength(2);
    const fn = between(auth, 'new sst.aws.Function("CognitoMessages"', "const customers");
    expect(fn).toContain("functions/cognito-messages/index.handler");
    expect(fn).not.toMatch(/vpc|link|permissions/);
  });

  it("builds a FIFO provisioning queue with a FIFO dead-letter queue, from the numbers of @tc/core", () => {
    expect([...messaging.matchAll(/fifo: true/g)]).toHaveLength(2);
    expect(messaging).toContain("../../packages/core/operations/queue-config");
    expect(messaging).toContain("PROVISIONING_QUEUE.visibilityTimeoutSeconds");
    expect(messaging).toContain(
      "dlq: { queue: deadLetter.arn, retry: PROVISIONING_QUEUE.maxReceiveCount }",
    );
    expect(messaging).not.toMatch(/contentBasedDeduplication: true/);
    expect(workers).toContain("queues.provisioning.subscribe(");
    expect(workers).toContain("partialResponses: PROVISIONING_QUEUE.reportBatchItemFailures");
  });

  it("alarms when the dead-letter queue is not empty, reusing DEAD_LETTER_ALARM, to SNS", () => {
    expect(alarms).toContain("DEAD_LETTER_ALARM");
    for (const key of [
      "namespace",
      "metric",
      "statistic",
      "periodSeconds",
      "evaluationPeriods",
      "threshold",
      "comparison",
      "treatMissingData",
    ]) {
      expect(alarms).toContain(`DEAD_LETTER_ALARM.${key}`);
    }
    expect(alarms).toContain("QueueName: queues.deadLetter.nodes.queue.name");
    expect(alarms).toContain("alarmActions: [topic.arn]");
    expect(alarms).toContain("new aws.sns.Topic(");
    expect(alarms).toContain('protocol: "email"');
    expect(alarms).toContain("SCHEDULER_ALARM");
  });

  it("keeps the three buckets private, versioned, HTTPS only, with Block Public Access and KMS", () => {
    for (const bucket of ["Kyc", "Invoices", "Exports"]) {
      expect(storage).toMatch(new RegExp(`privateBucket\\("${bucket}"`));
    }
    expect(storage).not.toMatch(/access: "(public|cloudfront)"/);
    expect(storage).toContain("enforceHttps: true");
    for (const flag of [
      "blockPublicAcls",
      "blockPublicPolicy",
      "ignorePublicAcls",
      "restrictPublicBuckets",
    ]) {
      expect(storage).toMatch(new RegExp(`${flag}: true`));
    }
    expect(storage).toContain('sseAlgorithm: "aws:kms"');
    expect(storage).toContain("enableKeyRotation: true");
  });

  it("denies GetObject on kyc to the web role and gives the web role no way to read kyc (WP2-T4 proof)", () => {
    expect(storage).toMatch(/effect: "deny"/);
    expect(storage).toContain('actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]');
    expect(storage).toContain('roleName(stage, "web")');
    expect(storage).toContain('privateBucket("Kyc", kycKey, [denyWebRead])');
    const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');
    // the web role writes kyc objects (presigned POST) and nothing else on that bucket or key
    expect(customer).toContain(
      'actions: ["s3:PutObject"], resources: [$interpolate`${storage.kyc.arn}/*`]',
    );
    expect(customer).toContain('actions: ["kms:GenerateDataKey"], resources: [storage.kycKey.arn]');
    expect(customer).not.toMatch(/kms:Decrypt"\], resources: \[storage\.kycKey/);
    const kycReads = [...customer.matchAll(/s3:GetObject[^}]*storage\.kyc\b/g)];
    expect(kycReads).toHaveLength(0);
    // admin is the reader
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    expect(admin).toContain(
      'actions: ["s3:GetObject"], resources: [$interpolate`${storage.kyc.arn}/*`]',
    );
    expect(admin).toContain('actions: ["kms:Decrypt"], resources: [storage.kycKey.arn]');
  });

  it("names the web role identically where it is created and where kyc denies it", () => {
    expect(web).toContain('server: fixedServerRole(roleName(stage, "web"))');
    expect(web).toContain('server: fixedServerRole(roleName(stage, "admin"))');
    expect(workers).toContain("args.name = roleName(inputs.config.stage, spec.dir)");
  });

  it("links no EPS secret to the admin app", () => {
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    expect(admin).not.toMatch(/WEB_SECRETS|Eps/);
  });
});
