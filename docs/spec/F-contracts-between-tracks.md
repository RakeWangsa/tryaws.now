<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 394-463. Change the plan, then run pnpm spec:split. -->

## F. Contracts between tracks

These signatures let the four tracks start on day one. They are starting contracts: change one only through a pull request that edits this section, and say so in `JOURNEY.md`. Server Actions in `apps/web` and `apps/admin` are thin wrappers with the action names of Section 16; they call these functions.

```ts
// packages/core/types.ts
export type Minor = bigint;                     // money in paisa (R4)
export type Locale = "bn" | "en";
export type ErrorCode =
  | "unauthenticated" | "forbidden" | "kyc_required" | "limit_reached" | "flag_off"
  | "validation" | "insufficient_balance" | "capacity_full" | "price_changed"
  | "conflict" | "not_found" | "rate_limited" | "upstream_unavailable" | "internal";
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode; fields?: Record<string, string>; data?: unknown; ref?: string };
export interface Clock { now(): Date }           // injected everywhere time matters (Section 11)

// packages/core/pricing
export interface PricingStep { code: string; rate: string; base: "aws" | "subtotal"; label: Record<Locale, string> }
export interface PriceQuote {
  currency: "BDT"; fxRate: string; ruleVersion: string;
  baseMinor: Minor; steps: { code: string; amountMinor: Minor }[]; totalMinor: Minor;
}
export function quote(awsPriceUsd: string, fxRate: string, steps: PricingStep[]): PriceQuote;

// packages/db
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
export function customerRepos(tx: Tx, customerId: string): CustomerRepos;   // every method is tenant-scoped (R8)
export function adminRepos(tx: Tx, actor: AdminActor): AdminRepos;          // every write also writes audit_log (R10)

// packages/core/ledger
export interface Posting { account: LedgerAccountRef; direction: "debit" | "credit"; amountMinor: Minor }
export function postTransaction(tx: Tx, input: {
  kind: LedgerKind; reference: { type: string; id: string };
  idempotencyKey: string; actor: Actor; memo?: string; postings: Posting[];
}): Promise<Result<{ transactionId: string }>>;
export function walletBalance(tx: Tx, customerId: string): Promise<Minor>;

// packages/auth
export function requireCustomer(): Promise<CustomerSession>;   // customerId, kycStatus, riskTier, locale, signedInAt
export function requireFreshSignIn(s: CustomerSession, clock: Clock): Result<true>;   // 10 minutes
export function requireAdmin(roles: AdminRole[]): Promise<AdminActor>;

// packages/eps
export function startTopUp(s: CustomerSession, input: { amountMinor: Minor; idempotencyKey: string }):
  Promise<Result<{ paymentId: string; redirectUrl: string }>>;
export function verifyPayment(merchantTransactionId: string):
  Promise<Result<{ state: "credited" | "pending" | "failed" | "cancelled" | "expired" }>>;

// packages/core/orders
export function createOrderDraft(s: CustomerSession, input: unknown):
  Promise<Result<{ token: string; quote: PriceQuote; expiresAt: Date }>>;
export function placeOrder(s: CustomerSession, input: { token: string; idempotencyKey: string }):
  Promise<Result<{ orderId: string }>>;          // "price_changed" carries the new PriceQuote in `data`

// packages/core/operations
export function enqueueOperation(tx: Tx, input: {
  resourceId: string; kind: OperationKind; payload: unknown;
  idempotencyKey: string; needsApproval?: boolean;
}): Promise<{ operationId: string }>;

// packages/core/flags
export function isEnabled(flag: FeatureFlag, market: string): Promise<boolean>;

// packages/notify
export function notify(tx: Tx, input: { customerId: string; template: TemplateId; data: Record<string, unknown> }): Promise<void>;
```

`ProductAdapter` (Section 10.3) is the contract between `packages/aws` and the `provisioner`. The live read contract is one function in `functions/reader`: `describe(resourceId, customerId)` and `metrics(resourceId, customerId, range)`, both of which check ownership themselves.

