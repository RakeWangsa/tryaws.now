import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { HeadResult } from "./handler";

// WPU-Y3. The one S3 call of kyc-check: HeadObject of one key in the kyc bucket. It returns the size and
// the content type and never a byte of the object. The role of the function has s3:GetObject on kyc/*
// (the permission HeadObject needs) and s3:ListBucket on the bucket for the prefix kyc/ (so a missing key
// answers 404, not 403); it has no grant on the bucket's key, so a GetObject of the content is refused
// (infra/stacks/workers.ts). No ServerSideEncryption header is sent: S3 refuses it on a HEAD.

export interface S3CommandSender {
  send(command: unknown): Promise<unknown>;
}

// The shape kycObjectKey of @tc/core produces: kyc/<customer uuid>/<submission uuid>/<index>.<ext>.
// handler.ts has already checked the owner; this is the store's own guard (R16).
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KYC_KEY = new RegExp(`^kyc/${UUID_PART}/${UUID_PART}/[0-9]\\.(?:jpg|png|pdf)$`);

const ERR_BUCKET = "kyc-check: the kyc bucket is not configured";
const ERR_KEY = "kyc-check: not a kyc key";
// Nothing of the SDK text leaves this file (R14): it can carry the bucket, an ARN or an account id.
const ERR_CHECK = "kyc-check: the object could not be checked";

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const meta = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : undefined;
}

export function createS3Head(deps: {
  readonly client: S3CommandSender;
  readonly bucket: string;
}): (key: string) => Promise<HeadResult> {
  if (deps.bucket.length === 0) throw new Error(ERR_BUCKET);
  return async (key) => {
    if (!KYC_KEY.test(key)) throw new Error(ERR_KEY);
    // The failure is reduced to its status code here; the error itself is dropped (R14).
    const sent = await deps.client
      .send(new HeadObjectCommand({ Bucket: deps.bucket, Key: key }))
      .then(
        (out) => ({ out: out as { ContentLength?: unknown; ContentType?: unknown }, status: 200 }),
        (error: unknown) => ({ out: null, status: statusOf(error) }),
      );
    const out = sent.out;
    if (out === null) {
      // 404: no such key, or its current version is a delete marker (the API reference of HeadObject).
      // 403 is NOT read as "missing": without s3:ListBucket S3 answers 403 for a missing key, but a 403 is
      // also a role or policy fault, and guessing would hide it. It is a failure (R16).
      if (sent.status === 404) return { present: false };
      throw new Error(ERR_CHECK);
    }
    if (typeof out.ContentLength !== "number") throw new Error(ERR_CHECK);
    return {
      present: true,
      size: out.ContentLength,
      contentType: typeof out.ContentType === "string" ? out.ContentType : "",
    };
  };
}

/** The real client: the default credential chain of the function role (R3), short timeouts. */
export function createS3Client(): S3CommandSender {
  return new S3Client({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 3000, throwOnRequestTimeout: true },
  });
}
