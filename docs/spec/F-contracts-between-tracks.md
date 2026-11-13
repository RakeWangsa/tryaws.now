<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "F. Contracts between tracks". Change the plan, then run pnpm spec:split. -->

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
export function quote(input: { awsPriceUsd: string; quantity?: string; fxRate: string; rule: { version: string; steps: PricingStep[] } }): PriceQuote;   // quantity for per-GB and daily prices (R4); the rule carries its version

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
  Promise<Result<{ orderId: string }>>;          // "price_changed" carries a new draft { token, quote, expiresAt } in `data`

// packages/core/operations
export function enqueueOperation(tx: Tx, input: {
  resourceId: string; kind: OperationKind; payload: unknown;
  idempotencyKey: string; needsApproval?: boolean;
}): Promise<{ operationId: string }>;   // inserts the row only (queued, next_run_at = now); the queue message is sent after commit

// packages/core/flags
export function isEnabled(flag: FeatureFlag, market: string): Promise<boolean>;

// packages/notify
export function notify(tx: Tx, input: { customerId?: string; email?: string; template: TemplateId; data: Record<string, unknown>; dedupeKey: string }): Promise<void>;   // inserts a `pending` row; `notifier` sends it after commit
```

`ProductAdapter` (Section 10.3) is the contract between `packages/aws` and the `provisioner`. The live read contract is one function in `functions/reader`: `describe(resourceId, caller)` and `metrics(resourceId, caller, range)`, where `caller` is `{ customerId }` or `{ adminId }`, both of which check ownership themselves, and `checkDomain(name)`, which reads no customer data.

**Reader additions: load balancer target health and database metrics (contract change WPU-Y6).** Two more read operations of `functions/reader`, both read-only and display-only. They use the same invocation event `{ action, resourceId, caller, ... }`, the same `caller` (`{ customerId }` from the `web` alias or `{ adminId }` from the `admin` alias), the same tenant check on the platform resource id, the same rate limit window per caller and the same fixed-word log line (`event` = `reader_read`, `action` = `target_health` or `database_metrics`, outcome; no id and no AWS text, R14). Order of every call (R9): authenticate, authorize (the tenant check, R8), validate, rate limit, execute, audit.

```ts
// functions/reader (shapes also exported to apps/web and apps/admin as types only)
export type MetricRange = "1h" | "1d" | "1w";     // as for `metrics`

// Load balancer target health. resourceId = the platform id of a resource of family `load_balancer`.
export type TargetHealthState = "healthy" | "unhealthy" | "initial" | "unused" | "draining" | "unavailable";
export type TargetHealthReason =                  // platform words, never the AWS strings; null when healthy
  | "registering" | "initial_checks"              // initial
  | "response_code_mismatch" | "timeout" | "failed_checks" | "internal_error"   // unhealthy
  | "not_registered" | "not_in_use" | "ip_unusable" | "stopped"                 // unused
  | "deregistering"                               // draining
  | "unknown";                                    // any value the platform does not know
export interface TargetHealth {
  targetResourceId: string;                       // platform id of the customer's own server, never an AWS name
  health: TargetHealthState;
  reason: TargetHealthReason | null;
}
export interface TargetHealthReport {
  resourceId: string;
  live: boolean;                                  // false: the load balancer is not live, targets is empty, AWS was not asked
  checkedAt: string;                              // ISO 8601, UTC, from the injected Clock
  targets: TargetHealth[];                        // at most 20 (the target limit of the product), sorted by targetResourceId
  counts: Record<TargetHealthState, number>;      // over `targets`
  unresolved: number;                             // targets AWS reported that match no recorded target of this load balancer
}
// event: { action: "targetHealth", resourceId, caller }
targetHealth(resourceId: string, caller: ReadCaller): Promise<ReaderResult<TargetHealthReport>>;

// Managed database metrics. resourceId = the platform id of a resource of family `database`.
export type DatabaseMetricName = "cpu" | "connections" | "freeStorage" | "diskQueue";
export interface DatabaseMetricSeries {
  metric: DatabaseMetricName;
  unit: "percent" | "count" | "bytes";
  statistic: "average" | "maximum" | "minimum";   // what one point means; stated so no screen has to guess
  periodSeconds: number;                          // seconds covered by one point
  points: { at: string; value: number }[];       // ISO 8601 UTC, ascending, finite numbers; a missing period is a missing point
}
export interface DatabaseMeasured { resourceId: string; range: MetricRange; series: DatabaseMetricSeries[] }
// event: { action: "databaseMetrics", resourceId, caller, range }
databaseMetrics(resourceId: string, caller: ReadCaller, range: MetricRange): Promise<ReaderResult<DatabaseMeasured>>;
```

Fixed content of the two reads.
- Target health maps the Lightsail `GetLoadBalancer` health summary (`instanceHealth`: `initial`, `healthy`, `unhealthy`, `unused`, `draining`, `unavailable`; `instanceHealthReason`: `Lb.RegistrationInProgress` and `Lb.InitialHealthChecking` to `registering` and `initial_checks`; `Instance.ResponseCodeMismatch`, `Instance.Timeout`, `Instance.FailedHealthChecks` and `Lb.InternalError` to `response_code_mismatch`, `timeout`, `failed_checks` and `internal_error`; `Instance.NotRegistered`, `Instance.NotInUse`, `Instance.IpUnusable` and `Instance.InvalidState` to `not_registered`, `not_in_use`, `ip_unusable` and `stopped`; `Instance.DeregistrationInProgress` to `deregistering`). A state the platform does not know becomes `unavailable`, a reason it does not know becomes `unknown`. The reader maps each generated server name back to a platform id only against the recorded targets of that same load balancer (the same list the target rule of Section 10.3 checks); a name that matches none is counted in `unresolved` and never shown.
- A load balancer that is not live (still being created, destroyed or purged) is answered from the database: `live` is false, `targets` is empty and AWS is not asked, as `describe` does. Only a live load balancer calls AWS.
- Database metrics reads the Lightsail database metrics for the range of `metrics` (periods 300, 900 and 3600 seconds for 1h, 1d and 1w): `cpu` = `CPUUtilization`, average, percent; `connections` = `DatabaseConnections`, maximum, count; `freeStorage` = `FreeStorageSpace`, minimum, bytes; `diskQueue` = `DiskQueueDepth`, maximum, count. All four series are returned or none. VERIFY at staging that these statistics and units are accepted for each metric (the AWS page names Sum as the most useful statistic for `FreeStorageSpace` and `DiskQueueDepth`, which would add up a value sampled each minute over a longer period) and record the result; a change of statistic or period changes only the values of `statistic` and `periodSeconds`, not the shape.
- Both reads require the family: a resource of another family is `validation`. A range that is not `1h`, `1d` or `1w` is `validation`. A resource that is missing, belongs to another customer, is not placed in a pool account or is unknown to the admin is `not_found`, with no way to tell these cases apart (R8).

Errors. Only the codes of `ErrorCode` that the reader already returns: `unauthenticated` (no caller, both caller keys, or a caller key that does not fit the alias), `not_found`, `validation`, `rate_limited`, `upstream_unavailable` (a role, credential or availability problem on our side) and `internal`. AWS "not found", throttling and access errors map as for `describe` and `metrics`. Fail closed (R16): any AWS error, an answer for another resource name, a non-finite or negative value, a metric that is not one of the four, more than 20 targets, or a tenant check that cannot complete refuses the whole read with one of these codes. The reader returns no partial list and no partial series, and never retries inside one call.

Callers and limits. Only the server side of `apps/web` (alias `web`, for the customer panel tabs of a load balancer and a database) and `apps/admin` (alias `admin`) call these reads, as they call `describe` and `metrics`; neither imports `packages/aws` (R1). The data is for display. The `provisioner`, the lifecycle engine, billing and the `reconciler` never use it to decide anything. The reader uses the existing `TcReader` role (Lightsail `Get*` only, Section 6), so these reads need no new permission, and adds no write.

Never returned: AWS account ids, ARNs, generated AWS names (`tc-<type>-<id>`), Region or zone names, IP addresses of targets, the health check path, raw AWS error text or exception names, and any customer-supplied text (R11, rule U6). A caller identifies every resource by its platform id only.

