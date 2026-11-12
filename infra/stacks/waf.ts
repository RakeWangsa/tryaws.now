// WP0-T2: AWS WAF (web ACLs in us-east-1 for CloudFront), the HSTS response headers policy and the
// admin IP allowlist for ops.<domain> (3.3, 6.2).
//
// NOT TYPE-CHECKED, see network.ts. WAF is built with Pulumi aws.wafv2 in a second provider for
// us-east-1 (scope CLOUDFRONT).
import { parseAllowlist } from "../lib/allowlist";
import { EDGE_REGION, resourceName, type StageConfig } from "../lib/stage";

// Rate-based rules (3.3). They are a coarse net per IP; the main control is the per-account and
// per-IP limit inside the app (R9, step "rate limit"), so these numbers only stop floods.
//
// Server Actions are POSTs to the page URL that carry a `Next-Action` header. A path match alone is
// weak (encoded paths, case), so every uriPath match applies URL_DECODE (priority 0) then LOWERCASE
// (priority 1), and the rules for pages additionally require the Next-Action header. A catch-all
// rule limits any POST that carries `Next-Action`, whatever the path.
// VERIFY: the real path of each page once the routes are final (apps/web/app/[locale]/...); the
// match is "contains", so /bn/... and /en/... both match. A double-encoded path still escapes one
// URL_DECODE; the managed Common rule set and the app limits are the answer to that.
const PAGE_RATE_RULES = [
  { name: "login", contains: "/login", limit: 100 },
  { name: "signup", contains: "/signup", limit: 100 },
  { name: "otp-verify", contains: "/verify", limit: 100 },
  { name: "topup", contains: "/wallet", limit: 100 },
  { name: "orders", contains: "/orders", limit: 200 },
] as const;
const SERVER_ACTION_LIMIT = 600;
// The EPS return routes (apps/web/app/pay/eps/{success,fail,cancel}/route.ts) export GET and HEAD
// only: they are browser redirects (SuccessUrl, FailUrl, CancelUrl). No method condition, so GET,
// HEAD and anything else are counted.
const EPS_RETURN = { name: "eps-return", contains: "/pay/eps/", limit: 300 } as const;

const decodeThenLowercase = [
  { priority: 0, type: "URL_DECODE" },
  { priority: 1, type: "LOWERCASE" },
];

const isPost = {
  byteMatchStatement: {
    searchString: "POST",
    fieldToMatch: { method: {} },
    positionalConstraint: "EXACTLY",
    textTransformations: [{ priority: 0, type: "NONE" }],
  },
};
// The header is present when its size is above 0.
const hasNextAction = {
  sizeConstraintStatement: {
    fieldToMatch: { singleHeader: { name: "next-action" } },
    comparisonOperator: "GT",
    size: 0,
    textTransformations: [{ priority: 0, type: "NONE" }],
  },
};
const pathContains = (contains: string) => ({
  byteMatchStatement: {
    searchString: contains,
    fieldToMatch: { uriPath: {} },
    positionalConstraint: "CONTAINS",
    textTransformations: decodeThenLowercase,
  },
});

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

function rateRule(name: string, priority: number, limit: number, statements: unknown[]) {
  return {
    name: `rate-${name}`,
    priority,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        limit,
        aggregateKeyType: "IP",
        evaluationWindowSec: 300,
        scopeDownStatement:
          statements.length === 1 ? statements[0] : { andStatement: { statements } },
      },
    },
    visibilityConfig: visibility(`rate-${name}`),
  };
}

function rateRules(firstPriority: number) {
  return [
    ...PAGE_RATE_RULES.map((rule, index) =>
      rateRule(rule.name, firstPriority + index, rule.limit, [
        isPost,
        hasNextAction,
        pathContains(rule.contains),
      ]),
    ),
    rateRule("server-actions", firstPriority + PAGE_RATE_RULES.length, SERVER_ACTION_LIMIT, [
      isPost,
      hasNextAction,
    ]),
    rateRule(EPS_RETURN.name, firstPriority + PAGE_RATE_RULES.length + 1, EPS_RETURN.limit, [
      pathContains(EPS_RETURN.contains),
    ]),
  ];
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
