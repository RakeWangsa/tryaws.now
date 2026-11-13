import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { kycObjectKey } from "@tc/core";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config";
import { createS3Head } from "./s3";

const KEY = kycObjectKey(
  "0192f3a0-0000-7000-8000-00000000000a",
  "0192f3a0-0000-7000-8000-000000000101",
  1,
  "application/pdf",
);

function client(answer: () => Promise<unknown>) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      send(command: unknown) {
        sent.push(command);
        return answer();
      },
    },
  };
}

const s3Error = (status: number, name: string) =>
  Object.assign(new Error(`${name} arn:aws:s3:::secret-bucket`), {
    name,
    $metadata: { httpStatusCode: status },
  });

describe("createS3Head", () => {
  it("sends exactly one HeadObject for the key in the configured bucket, and no other field", async () => {
    const c = client(async () => ({ ContentLength: 2048, ContentType: "application/pdf" }));
    const head = createS3Head({ client: c.client, bucket: "tc-stage-kyc" });
    expect(await head(KEY)).toEqual({ present: true, size: 2048, contentType: "application/pdf" });
    expect(c.sent).toHaveLength(1);
    const command = c.sent[0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: "tc-stage-kyc", Key: KEY });
  });

  it("reads a 404 (or a current delete marker) as not present", async () => {
    for (const error of [s3Error(404, "NotFound"), s3Error(404, "NoSuchKey")]) {
      const head = createS3Head({
        client: client(async () => Promise.reject(error)).client,
        bucket: "b-kyc",
      });
      expect(await head(KEY)).toEqual({ present: false });
    }
  });

  it("throws a fixed message on 403 and on every other failure: never 'missing' by guess (R16)", async () => {
    for (const error of [
      s3Error(403, "Forbidden"),
      s3Error(500, "InternalError"),
      new Error("x"),
    ]) {
      const head = createS3Head({
        client: client(async () => Promise.reject(error)).client,
        bucket: "b-kyc",
      });
      await expect(head(KEY)).rejects.toThrow(/^kyc-check: the object could not be checked$/);
    }
  });

  it("answers an empty type when S3 gives none, and refuses an answer without a size", async () => {
    const typeless = createS3Head({
      client: client(async () => ({ ContentLength: 3 })).client,
      bucket: "b-kyc",
    });
    expect(await typeless(KEY)).toEqual({ present: true, size: 3, contentType: "" });
    const sizeless = createS3Head({
      client: client(async () => ({ ContentType: "image/png" })).client,
      bucket: "b-kyc",
    });
    await expect(sizeless(KEY)).rejects.toThrow(/^kyc-check: the object could not be checked$/);
  });

  it("refuses a key outside kyc/ without calling S3", async () => {
    const c = client(async () => ({ ContentLength: 1 }));
    const head = createS3Head({ client: c.client, bucket: "b-kyc" });
    for (const key of ["invoices/a.pdf", "kyc/", `${KEY}x`, `/${KEY}`]) {
      await expect(head(key)).rejects.toThrow();
    }
    expect(c.sent).toEqual([]);
  });

  it("refuses an empty bucket name when it is built", () => {
    expect(() => createS3Head({ client: client(async () => ({})).client, bucket: "" })).toThrow();
  });
});

describe("readConfig", () => {
  it("reads the bucket name", () => {
    expect(readConfig({ KYC_BUCKET: "tryaws-now-staging-kycbucket-abc123" })).toEqual({
      bucket: "tryaws-now-staging-kycbucket-abc123",
    });
  });

  it("fails closed without a valid bucket, naming the variable and never its value (R3, R14)", () => {
    for (const env of [{}, { KYC_BUCKET: "" }, { KYC_BUCKET: "Has Space" }, { KYC_BUCKET: "a" }]) {
      expect(() => readConfig(env)).toThrow(/^kyc-check: KYC_BUCKET is missing or invalid$/);
    }
  });
});
