// WP0-T2, WP0-T3, WP0-T4: the rules of the SST app, proven by reading the source text of
// infra/stacks (SST is not installed here, so the declarations cannot run). A real deploy output
// is a manual step (JOURNEY.md). Comments are removed before any check, so a comment cannot
// satisfy or break a rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPTIONAL_SMS_SECRETS } from "../../infra/lib/functions.ts";

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
const config = source("infra/app.ts");

// The text of one `new sst.aws.<Kind>("<Name>", { ... })` call up to the next sibling call.
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = endMarker === undefined ? text.length : text.indexOf(endMarker, start + 1);
  return text.slice(start, end === -1 ? text.length : end);
}

describe("WP0-T2: stages, VPC, CloudFront, WAF", () => {
  it("guards the stage before anything is declared", () => {
    // infra/app.ts gets the environment from the root sst.config.ts (SST refuses static imports there).
    expect(config).toMatch(
      /export function appConfig\(stage: string, env: Env\)[\s\S]*assertDeployAllowed\(stage, env\)/,
    );
    expect(config).toContain("readStageConfig($app.stage, env)");
    expect(source("sst.config.ts")).toContain('return appConfig(input?.stage ?? "", process.env);');
    expect(config).toMatch(/protect: stageKind\(stage\) === "production"/);
    expect(config).toContain('home: "aws"');
    expect(config).toContain("providers: { aws: { region: REGION } }");
  });

  it("builds a VPC with two AZs and the NAT of the stage size (managed in full, WPU-B8)", () => {
    expect(network).toMatch(
      /new sst\.aws\.Vpc\("Vpc",\s*\{[\s\S]*az: AZ_COUNT[\s\S]*nat: sstNatOf\(nat\)/,
    );
    // WPU-Z10: lean builds one NAT instance itself (sstNatOf gives the Vpc no NAT); full stays managed.
    expect(network).toContain("const nat = sizing(config.size, config.kind).network.nat");
    expect(source("infra/lib/lean.ts")).toContain('network: { nat: "managed" }');
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
    // WPU-Z10: the hand-built provider carries SST's default tags (the budget's tag filter).
    expect(waf).toContain(
      'new aws.Provider("EdgeProvider", { region: EDGE_REGION, defaultTags: { tags: sstTags($app.name, stage) }})',
    );
    expect(waf).toContain("EDGE_REGION");
    expect([...waf.matchAll(/scope: "CLOUDFRONT"/g)].length).toBeGreaterThanOrEqual(4);
    // WPU-B8: the groups are listed in the sizing table (infra/lib/lean.ts); full keeps all three.
    expect(waf).toContain("sizing(config.size, config.kind).waf.managedGroups");
    const leanTable = source("infra/lib/lean.ts");
    for (const group of [
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      "AWSManagedRulesAmazonIpReputationList",
    ]) {
      expect(leanTable).toContain(`"${group}"`);
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
    // WPU-Z9: the Pulumi AWS 7.20.0 field is attributesRequireVerificationBeforeUpdates (plural).
    expect([
      ...auth.matchAll(
        /args\.userAttributeUpdateSettings = \{ attributesRequireVerificationBeforeUpdates: \["email"\] ?\}/g,
      ),
    ]).toHaveLength(2);
    expect(auth).not.toMatch(/attributesRequireVerificationBeforeUpdate:/);
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

  // WPU-Z10: protection, the final snapshot and the backup days follow removalRules and
  // backupRetentionDays, pinned per stage kind in tests/repo/staging-on-demand.test.mjs (production keeps
  // protection, the final snapshot and 14 or 7 days; staging, removed after each test session, gives
  // them up).
  it("keeps the instance private, protected, backed up 14 days, encrypted, with a final snapshot (R2)", () => {
    expect(instance).toContain("args.publiclyAccessible = false");
    expect(instance).toContain("args.deletionProtection = rules.databaseDeletionProtection");
    // WPU-B8: the days come from the sizing table; full is 14 (lean is 7). WPU-Z10: staging 1.
    expect(instance).toContain(
      "args.backupRetentionPeriod = backupRetentionDays(config.kind, config.size)",
    );
    expect(source("infra/lib/lean.ts")).toContain("backupRetentionDays: 14");
    expect(instance).toContain("args.storageEncrypted = true");
    expect(instance).toContain("args.kmsKeyId = key.arn");
    expect(instance).toContain("args.skipFinalSnapshot = !rules.databaseFinalSnapshot");
    expect(instance).toContain("args.vpcSecurityGroupIds = [net.databaseSecurityGroup.id]");
    expect(database).not.toMatch(
      /publiclyAccessible = true|deletionProtection = false|skipFinalSnapshot = true/,
    );
  });

  it("forces TLS on the instance and on the proxy", () => {
    // WPU-Z10 (verify review B1 database.ts:63): one rds.force_ssl = 1 REPLACES SST's 0
    // (infra/lib/database.ts withForcedTls, tested in tests/repo/staging-on-demand.test.mjs).
    expect(database).toContain("withForcedTls(existing ?? [])");
    expect(source("infra/lib/database.ts")).toMatch(/name: FORCE_SSL, value: "1"/);
    expect(database).toContain("args.requireTls = true");
    expect(database).toContain("args.vpcSecurityGroupIds = [net.proxySecurityGroup.id]");
    // WPU-B8: Multi-AZ in production comes from the sizing table (full).
    expect(database).toContain("multiAz: size.multiAz");
    expect(source("infra/lib/lean.ts")).toContain("multiAz: production");
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
    // the admin app links its own role password and the admin-only app secrets (WPU-X1: AdminIpLimitKey)
    expect(admin).toContain(
      "link: [...ADMIN_SECRETS.map((name) => secrets.app[name]), secrets.db.admin_rw]",
    );
    expect(admin).not.toMatch(/secrets\.db\.(web_rw|worker_rw|migrator|report_ro)/);
  });

  it("ships the migrations folder with the migrator and tells it where it is", () => {
    expect(workers).toContain('copyFiles: [{ from: "packages/db/migrations", to: "migrations" }]');
    expect(workers).toContain('env.MIGRATIONS_DIR = "/var/task/migrations"');
  });

  it("gives the notifier the panel origin and the verified sender, not a key", () => {
    expect(workers).toContain("env.PANEL_ORIGIN = `https://${config.webDomain}`");
    expect(workers).toContain("env.SES_FROM = config.sesFromAddress");
  });

  it("WPU-D4: tells the provisioner the tc-dns account and its ExternalId (plain values), and nothing else of it", () => {
    expect(workers).toMatch(
      /if \(spec\.dir === "provisioner"\) \{(?:(?!spec\.dir)[\s\S])*?env\.TC_DNS_ACCOUNT_ID = config\.dnsAccountId;\s*env\.TC_DNS_EXTERNAL_ID = config\.dnsExternalId;\s*\}/,
    );
    // the role to assume stays the function table's: the provisioner has the DNS provisioner role
    expect(workers).toContain("assumableRoleArns(role, config)");
  });

  it("WPU-D4: allows ses:SendEmail on the one verified identity, to the notifier only, and tells it the ARN", () => {
    expect(workers).toMatch(
      /if \(spec\.dir === "notifier"\) \{\s*permissions\.push\(\{\s*actions: \["ses:SendEmail"\],\s*resources: \[config\.sesIdentityArn\],?\s*\}\);/,
    );
    expect(workers.match(/"ses:/g)).toHaveLength(1);
    expect(workers).toContain("env.SES_IDENTITY_ARN = config.sesIdentityArn");
    expect(workers).not.toMatch(/ses:\*|ses:Send\*/);
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
    // Every sst.Secret with a second argument (a placeholder). WPU-Z18: the optional FirstAdminSub, whose
    // placeholder is not a value (the migrator reads it as "no secret"); tests/repo/first-admin.test.mjs
    // holds the rest of its rules. Final review M2: and the two optional SMS secrets, exactly those, whose
    // placeholder the readers treat as "SMS off".
    const placeholders = [...secrets.matchAll(/new sst\.Secret\(([^)]*),([^)]*)\)/g)].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    expect(placeholders).toEqual([
      "new sst.Secret(name, OPTIONAL_SECRET_PLACEHOLDER)",
      "new sst.Secret(FIRST_ADMIN_SUB_SECRET, OPTIONAL_SECRET_PLACEHOLDER)",
    ]);
    expect(secrets).toMatch(
      /OPTIONAL_SMS_SECRETS\.includes\(name\)\s*\?\s*new sst\.Secret\(name, OPTIONAL_SECRET_PLACEHOLDER\)\s*:\s*new sst\.Secret\(name\)/,
    );
    expect(OPTIONAL_SMS_SECRETS).toEqual(["SmsApiKey", "SmsSenderId"]);
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

  // WPU-Z15 (B6): without an explicit list Cognito gives an app client ALLOW_REFRESH_TOKEN_AUTH,
  // ALLOW_USER_SRP_AUTH and ALLOW_CUSTOM_AUTH (CreateUserPoolClient, ExplicitAuthFlows), so the
  // USER_PASSWORD_AUTH call of the admin sign-in would be refused and no admin could sign in.
  it("lets the admin app client use exactly the flow of the admin sign-in, and refresh", () => {
    const client = between(auth, "const adminClient", "return {");
    const list = /args\.explicitAuthFlows = \[([^\]]*)\]/.exec(client);
    expect(list, "explicitAuthFlows of adminClient").not.toBeNull();
    const allowed = [...(list?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    const signIn = source("packages/auth/admin-signin.ts");
    const used = [...signIn.matchAll(/AuthFlow: "([A-Z_]+)"/g)].map((m) => `ALLOW_${m[1]}`);
    expect(used).toEqual(["ALLOW_USER_PASSWORD_AUTH"]);
    expect(allowed).toEqual([...used, "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(client).toContain("args.generateSecret = false");
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
    expect(storage).toContain('privateBucket("Kyc", kycKey, forceEmptyBuckets, [denyWebRead])');
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

  // WPU-S8 (L1): an invoice PDF holds the buyer BIN or NID and the address. The admin role neither reads nor
  // writes the invoices bucket and cannot invoke the renderer; the renderer function writes, web reads.
  it("keeps the invoices bucket and the invoice renderer away from the admin role (WPU-S8)", () => {
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    expect(admin).not.toContain("storage.invoices");
    expect(admin).not.toContain("INVOICES_BUCKET");
    expect(admin).not.toContain("invoice-renderer");
    expect(admin).not.toMatch(/invoices\//);
    // what admin keeps: the exports bucket with its key
    expect(admin).toContain("$interpolate`${storage.exports.arn}/*`");
    // WPU-Z9 (least privilege): no grant on catalog-sync, nothing in apps/admin invokes it. The one
    // function admin may invoke is its own alias of the reader.
    expect(web).not.toContain("catalog-sync");
    expect(admin.match(/lambda:InvokeFunction/g)).toHaveLength(1);
    expect(admin).toContain(
      'actions: ["lambda:InvokeFunction"], resources: [workers.readerAliases.admin.arn]',
    );
    // WPU-Z9: the three function names of the web tier come from workers.invoked, fail closed (R16)
    expect(web).toContain("const fn = workers.invoked[dir];");
    expect(web).toContain("if (fn === undefined) throw new Error(`no function for ${dir}`);");
    expect(web.match(/_FUNCTION_NAME: functionOf\("[a-z-]+"\)\.name/g)).toHaveLength(3);
    expect(admin).toContain("storage.filesKey.arn");
    // the customer path invokes the renderer and gets the PDF in its answer (WPU-N1); WPU-B7 (L2): it holds
    // no read of the invoices bucket, only of exports
    const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');
    expect(customer).not.toContain("${storage.invoices.arn}");
    // security review 2: nothing in apps/web reads INVOICES_BUCKET (the PDF comes back in the renderer's
    // answer), so the variable is not set on the customer app either
    expect(customer).not.toContain("INVOICES_BUCKET");
    expect(customer).toContain("$interpolate`${storage.exports.arn}/*`");
    expect(customer).toContain("workers.rendererAliasWeb.arn");
    // WPU-N2: access-details only through its "web" alias, never the bare function
    expect(customer).toContain("workers.accessAliases.web.arn");
    expect(customer).not.toContain('invoke("access-details"');
    expect(customer).not.toMatch(/invoke\([^)]*"invoice-renderer"/);
    expect(customer).toContain("INVOICE_RENDERER_FUNCTION_NAME");
    expect(web.match(/rendererAliasWeb/g)).toHaveLength(1);
    expect(customer).not.toMatch(
      /s3:PutObject"\], resources: \[\$interpolate`\$\{storage\.invoices/,
    );
    // the renderer function is the one writer, PutObject only
    expect(workers).toContain(
      'actions: ["s3:PutObject"], resources: [$interpolate`${storage.invoices.arn}/*`]',
    );
  });

  // WPU-D1: the renderer runs a real browser on HTML it was given. Its network has no way out (no NAT, no
  // internet gateway route, one egress rule to the S3 prefix list on 443), its role has one S3 action on
  // one prefix and the key use that SSE-KMS needs, and its package carries the browser and the fonts.
  it("gives invoice-renderer no internet egress and no S3 action but PutObject (WPU-D1)", () => {
    // placement and size (the table, then the function declaration)
    const functionsLib = source("infra/lib/functions.ts");
    const spec = between(functionsLib, 'dir: "invoice-renderer"', 'dir: "scheduler"');
    expect(spec).toContain('placement: "isolated"');
    expect(spec).toContain('dbRole: "none"');
    expect(spec).toContain("poolRoles: []");
    expect(spec).toContain("timeoutSeconds: 60");
    expect(spec).toContain("memoryMb: 2048");
    expect(workers).toMatch(
      /spec\.placement === "isolated"\) \{ return \{ privateSubnets: net\.isolatedSubnetIds, securityGroups: \[net\.isolatedSecurityGroup\.id\]/,
    );
    // network: the subnets' route table has no default route, the group has one egress rule
    const isolatedNetwork = between(
      network,
      'new aws.ec2.RouteTable("IsolatedRouteTable"',
      "return {",
    );
    expect(isolatedNetwork).not.toMatch(
      /natGatewayId|gatewayId|transitGatewayId|vpcPeeringConnectionId|egressOnlyGatewayId|0\.0\.0\.0|::\/0/,
    );
    expect(isolatedNetwork).not.toMatch(/routes:|new aws\.ec2\.Route\(/);
    expect([...isolatedNetwork.matchAll(/prefixListIds/g)]).toHaveLength(1);
    expect([...isolatedNetwork.matchAll(/toPort: \d+/g)].map((m) => m[0])).toEqual(["toPort: 443"]);
    expect(isolatedNetwork).not.toMatch(/ingress/i);
    // role: PutObject on invoices/* and the key use, and no other S3 action, anywhere in the renderer branch
    const branch = between(
      workers,
      'if (spec.dir === "invoice-renderer") { permissions.push(',
      "return permissions;",
    );
    expect([...branch.matchAll(/actions: \[([^\]]*)\]/g)].map((m) => m[1])).toEqual([
      '"s3:PutObject"',
      '"kms:GenerateDataKey"',
    ]);
    expect(branch).toContain("$interpolate`${storage.invoices.arn}/*`");
    expect(branch).toContain("storage.filesKey.arn");
    expect(branch).not.toMatch(/s3:(Get|List|Delete|\*)|kms:(Decrypt|\*)|sts:|"\*"/);
    // no other function branch grants the renderer anything, and the renderer has no link and no secret
    expect(workers).not.toMatch(/invoice-renderer[^;]*sts:AssumeRole/);
    // environment and package
    expect(workers).toContain(
      'spec.dir === "invoice-renderer") { env.INVOICES_BUCKET = storage.invoices.name',
    );
    expect(workers).toContain('nodejs: { install: ["@sparticuz/chromium", "puppeteer-core"] }');
    expect(workers).toContain(
      'copyFiles: [{ from: "functions/invoice-renderer/fonts", to: "fonts" }]',
    );
    expect(workers).toContain('architecture: "x86_64"');
  });

  it("names the web role identically where it is created and where kyc denies it", () => {
    expect(web).toContain('server: fixedServerRole(roleName(stage, "web"))');
    expect(web).toContain('server: fixedServerRole(roleName(stage, "admin"))');
    expect(workers).toContain("args.name = roleName(inputs.config.stage, spec.name ?? spec.dir)");
  });

  it("links no EPS secret to the admin app", () => {
    const admin = between(web, 'new sst.aws.Nextjs("Admin"');
    expect(admin).not.toMatch(/WEB_SECRETS|Eps/);
  });

  it("gives web, admin and the database functions the NAME of their password secret, never a value", () => {
    expect(workers).toContain("env.DB_PASSWORD_SECRET = DB_PASSWORD_SECRET[spec.dbRole]");
    expect(web).toContain("DB_PASSWORD_SECRET: DB_PASSWORD_SECRET[role]");
    expect(web).toContain('dbEnvironment("web_rw")');
    expect(web).toContain('dbEnvironment("admin_rw")');
    for (const [name, text] of Object.entries({ web, workers })) {
      expect(text, name).not.toMatch(/DB_PASSWORD\b|DATABASE_URL|\.password\b/);
    }
  });
});
