import { describe, expect, it } from "vitest";
import * as core from "@tc/core";
import * as orders from "./index";

// The value exports of orders/index.ts, sorted. An addition or a removal is a visible diff of this
// test: the public surface of the order flow is decided here, not by accident.
const ORDERS_VALUES = [
  "CLIENT_KEY",
  "DEFAULT_TIER_LIMITS",
  "DRAFT_TTL_SECONDS",
  "checkCustomer",
  "checkLimits",
  "comparePrice",
  "compensateFailedCreate",
  "createOrderDraft",
  "draftHash",
  "makeOrders",
  "orderIdFor",
  "placeOrder",
  "runPurchase",
  "verifyDraft",
];

// The value exports of @tc/core before WP4-T4 Task 9 (captured at the commit that Task 9 started
// from, a literal and not read from git). None of them may disappear.
const BEFORE = [
  "ADMIN_TRANSITIONS",
  "APPROVAL_SETTING",
  "APPROVAL_UNTIL",
  "AWS_NAME_TYPES",
  "BLOCKED_RETRY_SECONDS",
  "DEAD_LETTER_ALARM",
  "FEATURE_FLAGS",
  "FX_SECOND_ADMIN_PERCENT",
  "INSERT_STATES",
  "LEASE_SECONDS",
  "LEDGER_ACCOUNT_TYPES",
  "LEDGER_CURRENCY",
  "LEDGER_KINDS",
  "LedgerError",
  "LedgerMismatchError",
  "MAX_ATTEMPTS",
  "MAX_KEY_LENGTH",
  "MAX_MEMO_LENGTH",
  "MAX_MINOR",
  "MAX_PATCH_BYTES",
  "MAX_POSTINGS",
  "MAX_REASON_LENGTH",
  "MAX_SCHEDULE_DAYS",
  "MAX_WAIT_SECONDS",
  "NamingError",
  "OPERATION_KINDS",
  "OPERATION_KIND_INFO",
  "PREVIEW_SAMPLES",
  "PROVISIONING_QUEUE",
  "PricingInputError",
  "RETRY_DELAYS_SECONDS",
  "SCHEDULER_ALARM",
  "SIBLING_BLOCKING_STATES",
  "SNAPSHOT_VERSION",
  "STALE_QUEUED_SECONDS",
  "STEP_ACCOUNTS",
  "STEP_NAME",
  "SWEEP_LIMIT",
  "SnapshotError",
  "TAG_KEYS",
  "TC_ENVS",
  "WAITLIST_TEMPLATE",
  "WORKER_TRANSITIONS",
  "WRITABLE_COLUMNS",
  "accountFor",
  "allocate",
  "assertTransition",
  "awsResourceName",
  "canTransition",
  "capacityWarning",
  "checkCapacity",
  "checkLedger",
  "checkStepResult",
  "compensateFailedCreate",
  "correctedUsed",
  "createFifoQueue",
  "createManualClock",
  "createMemoryQueue",
  "decideClaim",
  "decideFailure",
  "decideRefusal",
  "decimalAtMost",
  "enqueueOperation",
  "ensureSystemAccounts",
  "firstMessage",
  "freeUnits",
  "fxChangeNeedsSecondAdmin",
  "isDestructive",
  "isEnabled",
  "isEnabledIn",
  "isFeatureFlag",
  "isFinal",
  "isFxRateText",
  "isOperationKind",
  "isPlainDecimal",
  "isPositiveDecimal",
  "isPricingRule",
  "lastErrorText",
  "ledgerKey",
  "listFeatureFlags",
  "lockWallet",
  "makeEnqueueOperation",
  "maskPhone",
  "normalizeBdMobile",
  "notifyWaitlist",
  "openWallet",
  "parseMessageBody",
  "parseOtpCode",
  "parseSnapshot",
  "parseTopUpAmount",
  "planRelease",
  "postTransaction",
  "previewChange",
  "previewPricing",
  "pricingInForce",
  "problemFields",
  "quickAmountMinors",
  "quote",
  "quoteInForce",
  "readApprovalUntil",
  "recomputeUsed",
  "releaseCapacity",
  "requiresApproval",
  "reserveCapacity",
  "resolveNeeds",
  "resourceTags",
  "reverseTransaction",
  "runLedgerCheck",
  "savePricingRule",
  "sendAfterCommit",
  "setFeatureFlag",
  "setFxRate",
  "snapshotToQuote",
  "stepDone",
  "stepNext",
  "stepWait",
  "sweepOperations",
  "toAsciiDigits",
  "toFifoInput",
  "toSnapshot",
  "transitionOperation",
  "validateRule",
  "walletBalance",
  "walletEntriesSum",
];

// The products seam that Task 9 adds to @tc/core.
// WP2-T4: the identity check rules of packages/core/kyc.
const KYC = [
  "KYC_CONTENT_TYPES",
  "KYC_CUSTOMER_TYPES",
  "KYC_DOCUMENT_TYPES",
  "KYC_MAX_FILES",
  "KYC_MAX_FILE_BYTES",
  "KYC_MIN_FILES",
  "KYC_UPLOAD_TTL_SECONDS",
  "canSubmitKyc",
  "documentTypesFor",
  "kycObjectKey",
  "nextKycStatus",
  "normalizeDocumentNumber",
  "parseFileMeta",
  "parseKycStart",
  "parseKycSubmit",
  "redactDocumentNumber",
];

const PRODUCTS = [
  "parseInstanceConfig",
  "resolveInstance",
  "resolveProduct",
  // WP6-T4 and WP7-T1: bucket and container seams (pinned here by the WP6-T2/T3 merge)
  "CONTAINER_POWERS",
  "MAX_SCALE",
  "containerPlanFrom",
  "parseBucketAccess",
  "parseBucketConfig",
  "parseContainerConfig",
  "parseDeployment",
  // WP7-T2: the CDN seam and the pure origin rule
  "CDN_BUNDLES",
  "CDN_CACHE_BEHAVIORS",
  "CDN_ORIGIN_FAMILIES",
  "cdnBundleFrom",
  "checkCdnOrigin",
  "parseCdnConfig",
  "resolveCdn",
  // WP6-T2 and WP6-T3: the database and load balancer seams and the pure target rule
  "MAX_LB_TARGETS",
  "checkLbTargets",
  "parseDatabaseConfig",
  "parseLoadBalancerConfig",
  "resolveDatabase",
  "resolveLoadBalancer",
  // WP2-T2: email, password policy, display name and the auth form parsers
  "PASSWORD_MAX_LENGTH",
  "PASSWORD_MIN_LENGTH",
  "checkPassword",
  "normalizeDisplayName",
  "normalizeEmail",
  "parseConfirmEmailForm",
  "parseEmailForm",
  "parsePhoneCodeForm",
  "parsePhoneForm",
  "parseResetForm",
  "parseSignInForm",
  "parseSignUpForm",
  // WP3-T5: invoices (numbering, fiscal year, money text, lines, pure HTML)
  "InvoiceError",
  "buildInvoiceLines",
  "escapeHtml",
  "fiscalYearOf",
  "formatInvoiceNumber",
  "formatMinor",
  "invoicePdfKey",
  "parseLineAmount",
  "renderInvoiceHtml",
  // WP1-T5: catalog sync (the mapping, the active rule, the plan, the BDT price on read)
  "decideActive",
  "mapInstanceBundle",
  "planIsSafe",
  "planScopeSync",
  "priceCatalog",
  "priceRows",
];

// WP5-T4 adds the lifecycle engine to @tc/core.
const LIFECYCLE = [
  "DEFAULT_LIFECYCLE_CONFIG",
  "KEPT_CONFIG_FAMILIES",
  "LIFECYCLE_LIMIT",
  "LIFECYCLE_SETTING_KEYS",
  "SNAPSHOT_FAMILIES",
  "completeRestore",
  "decideDestructive",
  "decideSubscription",
  "destructiveGuard",
  "lifecycleHooks",
  "parseLifecycleConfig",
  "readLifecycleConfig",
  "renewSubscription",
  "renewalQuote",
  "runLifecycle",
];

// Names of the bucket and container tasks, merged without a pin.
const STORAGE_CONTAINER = [
  "CONTAINER_POWERS",
  "MAX_SCALE",
  "containerPlanFrom",
  "parseBucketAccess",
  "parseBucketConfig",
  "parseContainerConfig",
  "parseDeployment",
];

// WP7-T3 and WP7-T5 add the DNS record rules and metering to @tc/core.
const WP7 = [
  "CATCH_UP_DAYS",
  "DNS_DEFAULT_MAX_RECORD_SETS",
  "DNS_MAX_LABEL_LENGTH",
  "DNS_MAX_NAME_LENGTH",
  "DNS_MAX_TTL",
  "DNS_MAX_VALUES",
  "DNS_MIN_TTL",
  "DNS_RECORD_TYPES",
  "DNS_TXT_CHUNK",
  "DNS_TXT_MAX",
  "METERING_PAGE",
  "METERING_SETTING_KEYS",
  "SNAPSHOT_METRIC",
  "TRANSFER_TEMPLATES",
  "UNPAID_TEMPLATE",
  "allowanceLevel",
  "checkChange",
  "dailyMeteredChargeMinor",
  "defaultMeteringOps",
  "dhakaDay",
  "dhakaMonth",
  "isIpv4",
  "runMetering",
  "validateRecord",
  "validateZoneName",
];

describe("the public surface of the order flow", () => {
  it("lists exactly the value exports that were decided", () => {
    expect(Object.keys(orders).sort()).toEqual(ORDERS_VALUES);
  });

  it("does not let a Server Action mint a token or skip the secret check", () => {
    const keys = Object.keys(orders);
    expect(keys).not.toContain("signDraft");
    expect(keys).not.toContain("assertSecrets");
    expect(keys).not.toContain("productionDeps");
    const top = Object.keys(core);
    expect(top).not.toContain("signDraft");
    expect(top).not.toContain("assertSecrets");
    expect(top).not.toContain("productionDeps");
  });

  it("keeps every name that @tc/core exported before, and adds the orders and the products seam", () => {
    const top = new Set(Object.keys(core));
    for (const name of BEFORE) expect(top.has(name), name).toBe(true);
    for (const name of [...ORDERS_VALUES, ...PRODUCTS]) expect(top.has(name), name).toBe(true);
    expect(Object.keys(core).sort()).toEqual(
      [
        ...new Set([
          ...BEFORE,
          ...ORDERS_VALUES,
          ...PRODUCTS,
          ...LIFECYCLE,
          ...WP7,
          ...STORAGE_CONTAINER,
          ...KYC,
        ]),
      ].sort(),
    );
  });

  it("refuses the bare bindings until WP4-T7 wires productionDeps (open point 2)", async () => {
    const session = {
      customerId: "00000000-0000-4000-8000-000000000001",
      kycStatus: "verified",
      riskTier: "trusted",
      locale: "en",
    } as const;
    await expect(orders.createOrderDraft(session, {})).rejects.toThrow("orders: not configured");
    await expect(
      orders.placeOrder(session, { token: "x", idempotencyKey: "0123456789abcdef" }),
    ).rejects.toThrow("orders: not configured");
  });

  it("exposes the token and id helpers with the shape the Server Actions rely on", () => {
    expect(orders.DRAFT_TTL_SECONDS).toBe(1800);
    expect(orders.CLIENT_KEY.test("0123456789abcdef")).toBe(true);
    expect(orders.CLIENT_KEY.test("short")).toBe(false);
    expect(typeof orders.makeOrders).toBe("function");
  });
});
