// WP0-T2: AWS WAF (web ACLs in us-east-1 for CloudFront), the HSTS response headers policy and the
// admin IP allowlist for ops.<domain> (3.3, 6.2).
//
// NOT TYPE-CHECKED, see network.ts. WAF is built with Pulumi aws.wafv2 in a second provider for
// us-east-1 (scope CLOUDFRONT).
import { parseAllowlist } from "../lib/allowlist";
import { sizing } from "../lib/lean";
import { EDGE_REGION, resourceName, sstTags, type StageConfig } from "../lib/stage";

// Rate-based rules (3.3). They are a coarse net per IP; the main control is the per-account and
// per-IP limit inside the app (R9, step "rate limit"), so these numbers only stop floods.
//
// Server Actions are POSTs to the page URL that carry a `Next-Action` header. A path match alone is
// weak (encoded paths, case), so every uriPath match applies URL_DECODE (priority 0) then LOWERCASE
// (priority 1). The page rules need only POST + path (a client may leave the header out). A
// catch-all rule limits any POST that carries `Next-Action` or a form content type, whatever the path.
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
// Content types of form posts. Header names are matched case-insensitively by WAF (singleHeader
// name in lower case); the value is lower-cased so "Multipart/Form-Data" matches too.
// VERIFY: WAF v2 singleHeader name is case-insensitive, and CONTAINS on the header value works with
// the LOWERCASE transformation.
const contentTypeContains = (value: string) => ({
  byteMatchStatement: {
    searchString: value,
    fieldToMatch: { singleHeader: { name: "content-type" } },
    positionalConstraint: "CONTAINS",
    textTransformations: [{ priority: 0, type: "LOWERCASE" }],
  },
});
const isMultipartForm = contentTypeContains("multipart/form-data");
const isUrlEncodedForm = contentTypeContains("application/x-www-form-urlencoded");
const pathContains = (contains: string) => ({
  byteMatchStatement: {
    searchString: contains,
    fieldToMatch: { uriPath: {} },
    positionalConstraint: "CONTAINS",
    textTransformations: decodeThenLowercase,
  },
});

// WPU-X20: the order review page opens with `?d=<draft envelope>`. The envelope of a domain order holds
// the KMS-sealed registrant contact and is about 2.6 KB; the Common rule set rule
// SizeRestrictions_QUERYSTRING blocks a query string over 2,048 bytes, so CloudFront answered 403 (Gate B).
// The draft is a signed (HMAC), expiring, tenant-bound token sealed with AES-GCM (draft-envelope.ts, R8), and
// CloudFront takes URLs up to about 8 KB, so a longer query string on this one path opens no new surface.
// The least risky change: ONLY that one rule runs in Count on this path (a longer maximum is capped by a
// repo test of the largest envelope); every other rule of the Common group and every other path stay as they
// were. A WAF rule group cannot be tuned per path, so the group runs twice in the customer ACL: once for every
// path except this one (unchanged), once for this path only with the one rule overridden.
// VERIFY (first deploy): the web ACL accepts the same managed group in two rules and the review page answers 200.
// The same draft travels in `next` of the top-up page when the wallet is short (topup-link.ts), so that one
// path is covered too; its `next` is held to the U12 allow-list.
export const LONG_QUERY_PATHS = ["/orders/review", "/wallet/topup"] as const;
const SIZE_RESTRICTIONS_QUERYSTRING = "SizeRestrictions_QUERYSTRING";
const COMMON_GROUP = "AWSManagedRulesCommonRuleSet";
// The path ends with /orders/review (the locale prefix in front, /en or /bn), with or without a final slash.
const pathEndsWith = (suffix: string) => ({
  byteMatchStatement: {
    searchString: suffix,
    fieldToMatch: { uriPath: {} },
    positionalConstraint: "ENDS_WITH",
    textTransformations: decodeThenLowercase,
  },
});
const isReviewPath = {
  orStatement: {
    statements: LONG_QUERY_PATHS.flatMap((path) => [pathEndsWith(path), pathEndsWith(`${path}/`)]),
  },
};

type VisibilityName = string;
function visibility(name: VisibilityName) {
  return { cloudwatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: name };
}

function managedGroup(name: string, priority: number, scopeDown?: Statement) {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        name,
        vendorName: "AWS",
        ...(scopeDown === undefined ? {} : { scopeDownStatement: scopeDown }),
      },
    },
    visibilityConfig: visibility(name),
  };
}

// Customer ACL only (the admin ACL keeps managedGroup as it was): the Common group does not run on the
// review path, and a second copy of the Common group runs there with SizeRestrictions_QUERYSTRING in Count.
function customerManagedGroup(name: string, priority: number) {
  return name === COMMON_GROUP
    ? managedGroup(name, priority, { notStatement: { statements: [isReviewPath] } })
    : managedGroup(name, priority);
}
function reviewPathCommonGroup(priority: number) {
  const metric = "common-review-path";
  return {
    name: metric,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        name: COMMON_GROUP,
        vendorName: "AWS",
        scopeDownStatement: isReviewPath,
        ruleActionOverrides: [{ name: SIZE_RESTRICTIONS_QUERYSTRING, actionToUse: { count: {} } }],
      },
    },
    visibilityConfig: visibility(metric),
  };
}

// A nestable WAF statement as Pulumi AWS 7.20.0 types it (wafv2.WebAclRuleStatement).
type Statement = aws.types.input.wafv2.WebAclRuleStatement;

function rateRule(name: string, priority: number, limit: number, statements: Statement[]) {
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
      // POST + path only: a client that leaves out the Next-Action header (a plain form POST) is
      // still counted.
      rateRule(rule.name, firstPriority + index, rule.limit, [isPost, pathContains(rule.contains)]),
    ),
    // Catch-all, per IP: any POST that looks like a Server Action or a form submission.
    rateRule("server-actions", firstPriority + PAGE_RATE_RULES.length, SERVER_ACTION_LIMIT, [
      isPost,
      { orStatement: { statements: [hasNextAction, isMultipartForm, isUrlEncodedForm] } },
    ]),
    rateRule(EPS_RETURN.name, firstPriority + PAGE_RATE_RULES.length + 1, EPS_RETURN.limit, [
      pathContains(EPS_RETURN.contains),
    ]),
  ];
}

export function waf(config: StageConfig) {
  const stage = config.stage;
  // WPU-Z10: SST's own providers carry the default tags sst:app and sst:stage (useProvider copies the aws
  // configuration of the stack, defaultTags included); a provider built by hand does not, and the two web
  // ACLs (20 USD a month) would escape the tag filter of the budget (budget.ts). So it gets the same tags.
  // VERIFY (first deploy): the web ACLs and IP sets of us-east-1 show both tags.
  const edge = new aws.Provider("EdgeProvider", {
    region: EDGE_REGION,
    defaultTags: { tags: sstTags($app.name, stage) },
  });
  const opts = { provider: edge };
  // WPU-B8: lean keeps the Common group only; full keeps the three groups. Rate rules and the admin
  // allowlist are the same in both sizes.
  const managed = sizing(config.size, config.kind).waf.managedGroups;

  const customerAcl = new aws.wafv2.WebAcl(
    "CustomerWebAcl",
    {
      name: resourceName(stage, "web-acl"),
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      rules: [
        ...managed.map((group) => customerManagedGroup(group.name, group.priority)),
        reviewPathCommonGroup(15),
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
  // WPU-Z9: Pulumi AWS 7.20.0 names the negated statement `statements`, a list that holds the one
  // statement (wafv2.WebAclRuleStatementNotStatement in types/input.d.ts); there is no `statement`.
  const outsideAllowlist = {
    name: "block-outside-allowlist",
    priority: 0,
    action: { block: {} },
    statement: {
      notStatement: {
        statements: [
          {
            orStatement: {
              statements: [
                { ipSetReferenceStatement: { arn: ipSet4.arn } },
                { ipSetReferenceStatement: { arn: ipSet6.arn } },
              ],
            },
          },
        ],
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
        ...managed.map((group) => managedGroup(group.name, group.priority)),
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
