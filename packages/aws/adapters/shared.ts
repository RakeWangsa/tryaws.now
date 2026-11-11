import type { LightsailClient } from "@aws-sdk/client-lightsail";
import { resourceTags, type TcEnv } from "@tc/core";
import { AwsError } from "../errors";
import type { OpCtx } from "./types";

// Helpers of the WP5 adapters (backups, block storage). linux-instance.ts keeps its own private copies.

export const POLL_SECONDS = 10;
// An adapter bounds its own waiting (OpCtx.operation.createdAt).
export const MAX_WAIT_MS = 20 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function fail(
  code: "validation" | "conflict" | "upstream_unavailable" | "internal",
): AwsError {
  return new AwsError({ code, retryable: false });
}

export function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "not_found";
}

/** Runs a read that may find nothing: "not found" is `null`, any other error passes. */
export async function orNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Runs a delete: "not found" is done (a step that deletes). */
export async function ignoreNotFound(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function lightsailOf(ctx: OpCtx<unknown>): LightsailClient {
  return ctx.access.lightsail(ctx.account, ctx.region, "TcProvisioner");
}

export function checkWaitBudget(ctx: OpCtx<unknown>): void {
  if (ctx.clock.now().getTime() - ctx.operation.createdAt.getTime() > MAX_WAIT_MS) {
    throw fail("upstream_unavailable");
  }
}

export function pollAt(ctx: OpCtx<unknown>): Date {
  return new Date(ctx.clock.now().getTime() + POLL_SECONDS * 1000);
}

export function hasTag(
  tags: readonly { key?: string; value?: string }[] | undefined,
  key: string,
  value: string,
): boolean {
  return (tags ?? []).some((t) => t.key === key && t.value === value);
}

export function payloadOf(ctx: OpCtx<unknown>): Record<string, unknown> {
  const p = ctx.operation.payload;
  return typeof p === "object" && p !== null && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}

/**
 * Tags of a resource that is not always made by an order (a manual or final backup, a disk). The
 * `tc:order` value is the order of the payload, else the operation id: both are platform UUIDs (R11).
 */
export function tagsFor(
  ctx: OpCtx<unknown>,
  resourceId: string,
  os?: "linux" | "windows",
): { key: string; value: string }[] {
  const orderId = [payloadOf(ctx).orderId, ctx.operation.id].find(isUuid);
  if (orderId === undefined) throw fail("validation");
  return resourceTags({
    env: ctx.env as TcEnv,
    customerId: ctx.resource.customerId,
    resourceId,
    orderId,
    ...(os === undefined ? {} : { os }),
  });
}
