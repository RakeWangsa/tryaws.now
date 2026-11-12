// WP0-T2: AWS WAF (web ACLs in us-east-1 for CloudFront), the HSTS response headers policy and the
// admin IP allowlist for ops.<domain> (3.3, 6.2).
//
// NOT TYPE-CHECKED, see network.ts. WAF is built with Pulumi aws.wafv2 in a second provider for
// us-east-1 (scope CLOUDFRONT).
import { parseAllowlist } from "../lib/allowlist";
import { EDGE_REGION, resourceName, type StageConfig } from "../lib/stage";

// Rate-based rules for login, OTP, top-up and order endpoints (3.3). Server Actions POST to the page
// URL, so each rule matches method POST on those page paths, in both locales, and on /pay/eps/.
// VERIFY: the real path of each page once the routes are final (apps/web/app/[locale]/...). The
// match is "contains", so /bn/... and /en/... both match.
const RATE_RULES = [
  { name: "login", contains: "/login", limit: 100 },
  { name: "signup", contains: "/signup", limit: 100 },
  { name: "otp-verify", contains: "/verify", limit: 100 },
  { name: "topup", contains: "/wallet", limit: 100 },
  { name: "orders", contains: "/orders", limit: 200 },
  { name: "eps-return", contains: "/pay/eps/", limit: 300 },
] as const;

type VisibilityName = string;
function visibility(name: VisibilityName) {
  return { cloudwatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: name };
}

function managedGroup(name: string, priority: number) {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { name, vendorName: "AWS" } },
    visibilityConfig: visibility(name),
  };
}

function rateRules(firstPriority: number) {
  return RATE_RULES.map((rule, index) => ({
    name: `rate-${rule.name}`,
    priority: firstPriority + index,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        limit: rule.limit,
        aggregateKeyType: "IP",
        evaluationWindowSec: 300,
        scopeDownStatement: {
          andStatement: {
            statements: [
              {
                byteMatchStatement: {
                  searchString: "POST",
                  fieldToMatch: { method: {} },
                  positionalConstraint: "EXACTLY",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
              {
                byteMatchStatement: {
                  searchString: rule.contains,
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "CONTAINS",
                  textTransformations: [{ priority: 0, type: "LOWERCASE" }],
                },
              },
            ],
          },
        },
      },
    },
    visibilityConfig: visibility(`rate-${rule.name}`),
  }));
}

export function waf(config: StageConfig) {
  const stage = config.stage;
  const edge = new aws.Provider("EdgeProvider", { region: EDGE_REGION });
  const opts = { provider: edge };

  const customerAcl = new aws.wafv2.WebAcl(
    "CustomerWebAcl",
    {
      name: resourceName(stage, "web-acl"),
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      rules: [
        managedGroup("AWSManagedRulesCommonRuleSet", 10),
        managedGroup("AWSManagedRulesKnownBadInputsRuleSet", 20),
        managedGroup("AWSManagedRulesAmazonIpReputationList", 30),
        ...rateRules(40),
      ],
      visibilityConfig: visibility(resourceName(stage, "web-acl")),
    },
    opts,
  );

  // Admin: the IP allowlist is the first rule. Anything outside the list is blocked, then the same
  // managed groups run. An empty or too wide list makes parseAllowlist throw (fail closed, R16).
  const allowlist = parseAllowlist(config.adminAllowlist);
  const ipSet4 = new aws.wafv2.IpSet(
    "AdminIpSetV4",
    {
      name: resourceName(stage, "admin-ips-v4"),
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: [...allowlist.ipv4],
    },
    opts,
  );
  const ipSet6 = new aws.wafv2.IpSet(
    "AdminIpSetV6",
    {
      name: resourceName(stage, "admin-ips-v6"),
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV6",
      addresses: [...allowlist.ipv6],
    },
    opts,
  );
  const outsideAllowlist = {
    name: "block-outside-allowlist",
    priority: 0,
    action: { block: {} },
    statement: {
      notStatement: {
        statement: {
          orStatement: {
            statements: [
              { ipSetReferenceStatement: { arn: ipSet4.arn } },
              { ipSetReferenceStatement: { arn: ipSet6.arn } },
            ],
          },
        },
      },
    },
    visibilityConfig: visibility("block-outside-allowlist"),
  };
  // VERIFY: an IPv6 IpSet with zero addresses is accepted by WAF; if not, create the V6 set only
  // when the list holds IPv6 entries.
  const adminAcl = new aws.wafv2.WebAcl(
    "AdminWebAcl",
    {
      name: resourceName(stage, "admin-acl"),
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      rules: [
        outsideAllowlist,
        managedGroup("AWSManagedRulesCommonRuleSet", 10),
        managedGroup("AWSManagedRulesKnownBadInputsRuleSet", 20),
        managedGroup("AWSManagedRulesAmazonIpReputationList", 30),
      ],
      visibilityConfig: visibility(resourceName(stage, "admin-acl")),
    },
    opts,
  );

  // HSTS: the evidence page says no application code sets it (WPU-T2), so CloudFront adds it.
  // CloudFront policies are global; the resource lives in the default provider region.
  const securityHeaders = new aws.cloudfront.ResponseHeadersPolicy("SecurityHeaders", {
    name: resourceName(stage, "security-headers"),
    securityHeadersConfig: {
      strictTransportSecurity: {
        accessControlMaxAgeSec: 63072000,
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: "DENY", override: true },
      referrerPolicy: { referrerPolicy: "strict-origin-when-cross-origin", override: true },
    },
  });

  return {
    customerAclArn: customerAcl.arn,
    adminAclArn: adminAcl.arn,
    securityHeadersPolicyId: securityHeaders.id,
  };
}

export type Waf = ReturnType<typeof waf>;
