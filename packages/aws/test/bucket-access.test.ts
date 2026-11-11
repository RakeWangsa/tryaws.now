import { awsResourceName } from "@tc/core";
import { describe, expect, it, vi } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createBucketAccessKey } from "../adapters/bucket-access";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const BUCKET = awsResourceName("bucket", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const SECRET = "tc-test-bucket-secret-value-123";

function setup() {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({
    caller: "access-details",
    clock,
    requestHandler: aws.handler,
  });
  const input = (over: Record<string, unknown> = {}) => ({
    access,
    account: POOL,
    region: "ap-southeast-1" as const,
    resourceId: RID,
    resourceState: "active",
    ...over,
  });
  return { aws, input };
}

describe("createBucketAccessKey", () => {
  it("returns the secret once, from the CreateBucketAccessKey response only", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({ accessKeys: [{ accessKeyId: "A1" }] }),
    );
    aws.on(
      "lightsail",
      "CreateBucketAccessKey",
      lightsailOk({
        accessKey: {
          accessKeyId: "AKIAFAKEKEYNEW00001",
          secretAccessKey: SECRET,
          status: "Active",
        },
      }),
    );
    const r = await createBucketAccessKey(input());
    expect(r).toEqual({ accessKeyId: "AKIAFAKEKEYNEW00001", secretAccessKey: SECRET });
    expect(JSON.parse(aws.seen.find((s) => s.action === "CreateBucketAccessKey")!.body)).toEqual({
      bucketName: BUCKET,
    });
    // the secret is not in anything that was sent
    expect(aws.seen.map((s) => s.body).join("\n")).not.toContain(SECRET);
  });

  it("writes nothing to the console, and the secret is not in an error", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { aws, input } = setup();
    aws.on("lightsail", "GetBucketAccessKeys", lightsailOk({ accessKeys: [] }));
    aws.on(
      "lightsail",
      "CreateBucketAccessKey",
      lightsailOk({ accessKey: { accessKeyId: "AKIAFAKEKEYNEW00001", secretAccessKey: SECRET } }),
    );
    await createBucketAccessKey(input());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
    // a response without the secret is an error that carries no text of AWS
    const second = setup();
    second.aws.on("lightsail", "GetBucketAccessKeys", lightsailOk({ accessKeys: [] }));
    second.aws.on("lightsail", "CreateBucketAccessKey", lightsailOk({ accessKey: {} }));
    await expect(createBucketAccessKey(second.input())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("refuses a bucket that is not active: suspend removes access and nothing mints a key (R16)", async () => {
    const { aws, input } = setup();
    for (const resourceState of ["suspended", "creating", "destroyed", "failed", "stopped"]) {
      await expect(createBucketAccessKey(input({ resourceState }))).rejects.toMatchObject({
        code: "conflict",
      });
    }
    expect(aws.seen.filter((s) => s.service === "lightsail")).toEqual([]);
  });

  it("refuses a third key (AWS allows two) without creating one", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({ accessKeys: [{ accessKeyId: "A1" }, { accessKeyId: "A2" }] }),
    );
    await expect(createBucketAccessKey(input())).rejects.toMatchObject({ code: "limit_reached" });
    expect(aws.seen.map((s) => s.action)).not.toContain("CreateBucketAccessKey");
  });

  it("names the bucket from the resource id only and fails on a bad id", async () => {
    const { input } = setup();
    await expect(createBucketAccessKey(input({ resourceId: "../x" }))).rejects.toBeDefined();
  });

  it("maps AWS errors without their text", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailError(400, "NotFoundException", "arn:aws:x 210987654321"),
    );
    await expect(createBucketAccessKey(input())).rejects.toMatchObject({ code: "not_found" });
  });
});
