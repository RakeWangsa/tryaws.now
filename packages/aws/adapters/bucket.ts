import {
  DeleteBucketAccessKeyCommand,
  DeleteBucketCommand,
  CreateBucketCommand,
  GetBucketAccessKeysCommand,
  GetBucketsCommand,
  SetResourceAccessForBucketCommand,
  UpdateBucketCommand,
  type Bucket,
  type LightsailClient,
} from "@aws-sdk/client-lightsail";
import {
  awsResourceName,
  parseBucketAccess,
  parseBucketConfig,
  resourceTags,
  stepDone,
  stepNext,
  type BucketConfig,
  type OperationKind,
  type StepResult,
} from "@tc/core";
import { AwsError } from "../errors";
import { isUuid } from "./shared";
import type { LiveState, OpCtx, ProductAdapter } from "./types";

/**
 * What the adapter needs and OpCtx does not carry: the catalog bundle id of the product, read with
 * the customer id of the resource row (never a payload). null when the product is not a bucket
 * product: the create then fails closed (R16).
 */
export interface BucketDeps {
  loadBundle(input: {
    readonly customerId: string;
    readonly productId: string;
  }): Promise<string | null>;
}

const PRIVATE = Object.freeze({ getObject: "private", allowPublicOverrides: false } as const);
const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;

interface SavedAccess {
  readonly getObject: "private" | "public";
  readonly allowPublicOverrides: false;
  readonly readonlyAccessAccounts: readonly string[];
}

function fail(code: "validation" | "conflict" | "not_found" | "internal"): AwsError {
  return new AwsError({ code, retryable: false });
}

function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "not_found";
}

async function orNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function client(ctx: OpCtx<BucketConfig>): LightsailClient {
  return ctx.access.lightsail(ctx.account, ctx.region, "TcProvisioner");
}

function hasTag(tags: readonly { key?: string; value?: string }[] | undefined, value: string) {
  return (tags ?? []).some((t) => t.key === "tc:resource" && t.value === value);
}

/** The bucket of that name, or null (GetBuckets answers either "not found" or an empty list). */
async function findBucket(lightsail: LightsailClient, name: string): Promise<Bucket | null> {
  const got = await orNull(() => lightsail.send(new GetBucketsCommand({ bucketName: name })));
  return got?.buckets?.find((b) => b.name === name) ?? null;
}

function savedAccess(ctx: OpCtx<BucketConfig>): SavedAccess | null {
  const config = ctx.resource.config;
  if (typeof config !== "object" || config === null) return null;
  const raw = (config as Record<string, unknown>).savedAccess;
  if (typeof raw !== "object" || raw === null) return null;
  const { getObject, allowPublicOverrides, readonlyAccessAccounts } = raw as Record<
    string,
    unknown
  >;
  if (getObject !== "private" && getObject !== "public") return null;
  if (allowPublicOverrides !== false) return null;
  if (
    !Array.isArray(readonlyAccessAccounts) ||
    !readonlyAccessAccounts.every((a) => typeof a === "string")
  ) {
    return null;
  }
  return {
    getObject,
    allowPublicOverrides: false,
    readonlyAccessAccounts: [...readonlyAccessAccounts],
  };
}

export function createBucketAdapter(deps: BucketDeps): ProductAdapter<BucketConfig> {
  const bucketName = (ctx: OpCtx<BucketConfig>) => awsResourceName("bucket", ctx.resource.id);

  async function create(ctx: OpCtx<BucketConfig>): Promise<StepResult> {
    const name = bucketName(ctx);
    const lightsail = client(ctx);
    if (ctx.operation.step === null || ctx.operation.step === "create_bucket") {
      const bundleId = await deps.loadBundle({
        customerId: ctx.resource.customerId,
        productId: ctx.config.productId,
      });
      if (bundleId === null) throw fail("validation");
      const found = await findBucket(lightsail, name);
      if (found !== null) {
        // A retry continues with what an earlier try made, if it is ours.
        if (!hasTag(found.tags, ctx.resource.id)) throw fail("conflict");
        return stepNext("set_private", { awsName: name });
      }
      const orderId = (ctx.operation.payload as { orderId?: unknown } | null)?.orderId;
      await lightsail.send(
        new CreateBucketCommand({
          bucketName: name,
          bundleId,
          enableObjectVersioning: false,
          tags: resourceTags({
            env: ctx.env,
            customerId: ctx.resource.customerId,
            resourceId: ctx.resource.id,
            orderId: orderId as string,
          }),
        }),
      );
      return stepNext("set_private", { awsName: name });
    }
    if (ctx.operation.step === "set_private") {
      // The default of a new bucket is private; the platform sets it anyway.
      await lightsail.send(
        new UpdateBucketCommand({
          bucketName: name,
          accessRules: { ...PRIVATE },
          readonlyAccessAccounts: [],
        }),
      );
      return stepDone({ state: "active", awsName: name });
    }
    throw fail("internal");
  }

  async function deleteAllKeys(lightsail: LightsailClient, name: string): Promise<void> {
    const keys = await lightsail.send(new GetBucketAccessKeysCommand({ bucketName: name }));
    for (const key of keys.accessKeys ?? []) {
      if (key.accessKeyId === undefined) continue;
      try {
        await lightsail.send(
          new DeleteBucketAccessKeyCommand({ bucketName: name, accessKeyId: key.accessKeyId }),
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  // Suspend (10.3): remember the access rules, make the bucket private, delete the access keys. A
  // secret key is never stored, so the keys cannot come back at resume.
  async function suspend(ctx: OpCtx<BucketConfig>): Promise<StepResult> {
    const name = bucketName(ctx);
    const lightsail = client(ctx);
    const step = ctx.operation.step;
    if (step === null || step === "save_access") {
      // A retry after the block must not save the private rules over the real ones.
      if (savedAccess(ctx) !== null) return stepNext("block");
      const bucket = await findBucket(lightsail, name);
      if (bucket === null) throw fail("not_found");
      const get = bucket.accessRules?.getObject;
      const saved: SavedAccess = {
        // Anything that is not clearly "public" is saved as private: fail closed (R16).
        getObject: get === "public" ? "public" : "private",
        allowPublicOverrides: false,
        readonlyAccessAccounts: [...(bucket.readonlyAccessAccounts ?? [])],
      };
      return stepNext("block", { configMerge: { savedAccess: saved } });
    }
    if (step === "block") {
      await lightsail.send(
        new UpdateBucketCommand({
          bucketName: name,
          accessRules: { ...PRIVATE },
          readonlyAccessAccounts: [],
        }),
      );
      return stepNext("delete_keys");
    }
    if (step === "delete_keys") {
      await deleteAllKeys(lightsail, name);
      return stepDone({ state: "suspended" });
    }
    throw fail("internal");
  }

  async function resume(ctx: OpCtx<BucketConfig>): Promise<StepResult> {
    const saved = savedAccess(ctx);
    if (saved === null) throw fail("validation");
    await client(ctx).send(
      new UpdateBucketCommand({
        bucketName: bucketName(ctx),
        accessRules: { getObject: saved.getObject, allowPublicOverrides: false },
        readonlyAccessAccounts: [...saved.readonlyAccessAccounts],
      }),
    );
    // Cleared, so that a later suspend saves the rules of that day.
    return stepDone({ state: "active", configMerge: { savedAccess: null } });
  }

  // A bucket has no snapshot (R13 ruling in JOURNEY.md): nothing to do.
  async function noSnapshot(): Promise<StepResult> {
    return stepDone();
  }

  async function destroy(ctx: OpCtx<BucketConfig>): Promise<StepResult> {
    // The data goes with the bucket and cannot come back: only a suspended bucket (R13, R16).
    if (ctx.resource.state !== "suspended") throw fail("conflict");
    try {
      await client(ctx).send(
        new DeleteBucketCommand({ bucketName: bucketName(ctx), forceDelete: true }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return stepDone({ state: "destroyed" });
  }

  async function describe(ctx: OpCtx<BucketConfig>): Promise<LiveState> {
    const bucket = await findBucket(client(ctx), bucketName(ctx));
    const code = bucket?.state?.code;
    return { state: bucket === null ? "missing" : (code ?? "unknown").toLowerCase() };
  }

  async function action(kind: OperationKind, ctx: OpCtx<BucketConfig>): Promise<StepResult> {
    const name = bucketName(ctx);
    const lightsail = client(ctx);
    const payload = ctx.operation.payload as Record<string, unknown> | null;
    switch (kind) {
      case "set_bucket_access": {
        const rules = parseBucketAccess(payload);
        if (rules === null) throw fail("validation");
        // A suspended bucket stays closed until it is resumed.
        if (ctx.resource.state !== "active") throw fail("conflict");
        await lightsail.send(
          new UpdateBucketCommand({ bucketName: name, accessRules: { ...rules } }),
        );
        // The web tier reads the mode from the config (B2 of WP6-T4).
        return stepDone({ configMerge: { accessMode: rules.getObject } });
      }
      case "set_bucket_resource_access": {
        // WPU-G9. Opens or closes the bucket to ONE instance of the same customer (the console's
        // "Resource access"). The instance is a row (R8), its AWS name is generated (R11).
        const instanceId = payload?.instanceId;
        const access = payload?.access;
        if (!isUuid(instanceId) || (access !== "allow" && access !== "deny"))
          throw fail("validation");
        const row = await ctx.owned(instanceId);
        if (
          row === null ||
          row.customerId !== ctx.resource.customerId ||
          (row.family !== "linux_instance" && row.family !== "windows_instance") ||
          (row.state !== "active" && row.state !== "stopped")
        ) {
          throw fail("validation");
        }
        if (ctx.resource.state !== "active") throw fail("conflict");
        await lightsail.send(
          new SetResourceAccessForBucketCommand({
            resourceName: awsResourceName("instance", instanceId),
            bucketName: name,
            access,
          }),
        );
        const raw = (ctx.resource.config as Record<string, unknown> | null)?.accessInstances;
        const current = Array.isArray(raw) ? raw.filter(isUuid) : [];
        const next =
          access === "allow"
            ? [...new Set([...current, instanceId])].slice(0, 20)
            : current.filter((id) => id !== instanceId);
        return stepDone({ configMerge: { accessInstances: next } });
      }
      case "set_bucket_versioning": {
        const versioning = payload?.versioning;
        if (versioning !== "Enabled" && versioning !== "Suspended") throw fail("validation");
        if (ctx.resource.state !== "active") throw fail("conflict");
        await lightsail.send(new UpdateBucketCommand({ bucketName: name, versioning }));
        return stepDone({ configMerge: { versioning } });
      }
      case "delete_access_key": {
        const id = payload?.accessKeyId;
        if (typeof id !== "string" || !KEY_ID.test(id)) throw fail("validation");
        // Only a key that the bucket of this resource lists is deleted (R8).
        const keys = await lightsail.send(new GetBucketAccessKeysCommand({ bucketName: name }));
        if (!(keys.accessKeys ?? []).some((k) => k.accessKeyId === id)) throw fail("not_found");
        try {
          await lightsail.send(
            new DeleteBucketAccessKeyCommand({ bucketName: name, accessKeyId: id }),
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return stepDone();
      }
      default:
        throw fail("validation");
    }
  }

  return {
    family: "bucket",
    parseConfig(input: unknown): BucketConfig {
      const parsed = parseBucketConfig(input);
      if (!parsed.ok) throw fail("validation");
      return parsed.value;
    },
    aws: {
      create,
      suspend,
      resume,
      finalSnapshot: noSnapshot,
      destroy,
      purgeSnapshots: noSnapshot,
      describe,
      action,
    },
  };
}
