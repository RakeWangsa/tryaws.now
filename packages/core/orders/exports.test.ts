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
const PRODUCTS = ["parseInstanceConfig", "resolveInstance", "resolveProduct"];

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
      [...new Set([...BEFORE, ...ORDERS_VALUES, ...PRODUCTS])].sort(),
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
