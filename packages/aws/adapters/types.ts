import type { Clock, OperationKind, StepResult, TcEnv } from "@tc/core";
import type { AwsAccess } from "../access";
import type { AccountRef, LightsailRegion } from "../roles";

// The list of families belongs to packages/core/products.
export type ProductFamily = string;

// A row of `resources` without the pool columns, `region` and dates.
export interface ResourceView {
  readonly id: string;
  readonly customerId: string;
  readonly family: ProductFamily;
  readonly productId: string | null;
  readonly parentResourceId: string | null;
  readonly awsName: string | null;
  readonly state: string;
  readonly config: unknown;
}

export interface OpCtx<C> {
  readonly operation: {
    readonly id: string;
    readonly kind: OperationKind;
    // null on the first run of the operation, otherwise the step the previous result named.
    readonly step: string | null;
    // 1 for the first try of a step.
    readonly attempt: number;
    // Lets an adapter bound its own waiting.
    readonly createdAt: Date;
    readonly payload: unknown;
  };
  // `<operation id>:<step, or "start">`; the same on every try of that step.
  readonly stepKey: string;
  readonly resource: ResourceView;
  readonly config: C;
  // The account id and the ExternalId only.
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  readonly access: AwsAccess<"provisioner">;
  readonly env: TcEnv;
  readonly clock: Clock;
  // The resource with that id only if it belongs to the customer of this operation, else null. The
  // runner builds it with loadOwnedResource in a short transaction of its own, because the adapter
  // runs outside any transaction.
  readonly owned: (resourceId: string) => Promise<ResourceView | null>;
}

// WP5-T3 (the reader) extends it.
export interface LiveState {
  readonly state: string;
}

/**
 * The interface of 10.3 without `capacityNeeds` (its type belongs to packages/core/products, and
 * WP4-T3 and WP4-T4 add that one method).
 *
 * The rules of an adapter, which the runner relies on:
 * - A method does the work of `ctx.operation.step` only and returns `stepNext`, `stepWait` or
 *   `stepDone`.
 * - It is idempotent: the AWS name comes from `awsResourceName(type, ctx.resource.id)`, and a retry
 *   finds the resource by that name and its `tc:resource` tag and continues.
 * - It gets a Lightsail client only from `ctx.access.lightsail(ctx.account, ctx.region,
 *   "TcProvisioner")`.
 * - It lets an `AwsError` of the clients pass (the engine reads `retryable` and `poolFull`).
 * - It validates `ctx.operation.payload` itself: the payload is written by the web tier, so it is
 *   input.
 * - An id in the payload that names another resource (a disk, a static IP, a target instance) is
 *   resolved with `ctx.owned`, and an AWS name is never built from a payload id that `ctx.owned`
 *   did not return. All customers of a pool account share one account and Region, so another
 *   customer's id would otherwise reach that customer's object (R8).
 * - A step that deletes treats "not found" as done.
 * - It never writes a log line with AWS text.
 *
 * The runner never calls `describe`; the `reader` does (WP5-T3).
 */
export interface ProductAdapter<C> {
  family: ProductFamily;
  parseConfig(input: unknown): C;
  aws: {
    create(ctx: OpCtx<C>): Promise<StepResult>;
    suspend(ctx: OpCtx<C>): Promise<StepResult>;
    resume(ctx: OpCtx<C>): Promise<StepResult>;
    finalSnapshot(ctx: OpCtx<C>): Promise<StepResult>;
    destroy(ctx: OpCtx<C>): Promise<StepResult>;
    purgeSnapshots(ctx: OpCtx<C>): Promise<StepResult>;
    describe(ctx: OpCtx<C>): Promise<LiveState>;
    action(kind: OperationKind, ctx: OpCtx<C>): Promise<StepResult>;
  };
}
