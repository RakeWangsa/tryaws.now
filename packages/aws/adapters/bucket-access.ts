import {
  CreateBucketAccessKeyCommand,
  GetBucketAccessKeysCommand,
} from "@aws-sdk/client-lightsail";
import { awsResourceName } from "@tc/core";
import type { AwsAccess } from "../access";
import { AwsError } from "../errors";
import type { AccountRef, LightsailRegion } from "../roles";

export interface BucketAccessKeyInput {
  readonly access: AwsAccess<"access-details">;
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The resource id of the bucket, already checked against the customer by the caller (R8). */
  readonly resourceId: string;
  /** The `resources.state` the caller read in the same tenant-scoped check. */
  readonly resourceState: string;
}

/** The only place a bucket secret exists. The caller returns it once (U9) and drops it. */
export interface BucketAccessKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

// AWS allows two access keys per bucket (10.3).
const MAX_KEYS = 2;

/**
 * Creates an access key for a bucket and hands its secret to the caller, once: AWS returns the
 * secret only in this response (U9, R14). The secret is never stored, logged, put in an error or
 * kept in a variable that outlives the call.
 *
 * The caller (the access-details function) does the tenant check, the rate limit, the audit row and
 * the unique key (R7, R8, R9): a key is not an idempotent thing, so a retried request must be
 * answered from its audit row, never by calling this again.
 *
 * A bucket that is not active gets no key: suspend removed the access and a new key would undo it
 * (R16).
 */
export async function createBucketAccessKey(input: BucketAccessKeyInput): Promise<BucketAccessKey> {
  if (input.resourceState !== "active") {
    throw new AwsError({ code: "conflict", retryable: false });
  }
  const bucketName = awsResourceName("bucket", input.resourceId);
  const lightsail = input.access.lightsail(input.account, input.region, "TcAccessDetails");
  const existing = await lightsail.send(new GetBucketAccessKeysCommand({ bucketName }));
  if ((existing.accessKeys ?? []).length >= MAX_KEYS) {
    throw new AwsError({ code: "limit_reached", retryable: false });
  }
  const created = await lightsail.send(new CreateBucketAccessKeyCommand({ bucketName }));
  const key = created.accessKey;
  if (key?.accessKeyId === undefined || key.secretAccessKey === undefined) {
    throw new AwsError({ code: "upstream_unavailable", retryable: false });
  }
  return { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
}
