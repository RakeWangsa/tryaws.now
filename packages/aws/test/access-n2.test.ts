import { awsResourceName } from "@tc/core";
import { describe, expect, it, vi } from "vitest";
import { createAwsAccessInternal } from "../access";
import { listBucketAccessKeys } from "../adapters/bucket-access";
import { fetchDatabasePassword } from "../adapters/database-access";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-N2: the database master password and the bucket key list, both with the TcAccessDetails role.
const RID = "11111111-2222-4333-8444-555555555555";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const NOW = Date.now();
const SECRET = "tc-test-db-password-value-123";

function setup() {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({
    caller: "access-details",
    clock: { now: () => new Date(NOW) },
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

describe("fetchDatabasePassword", () => {
  it("reads the CURRENT master password of the generated database name", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabaseMasterUserPassword",
      lightsailOk({ masterUserPassword: SECRET }),
    );
    const r = await fetchDatabasePassword(input());
    expect(r).toEqual({ username: "tcadmin", password: SECRET });
    const sent = aws.seen.find((s) => s.action === "GetRelationalDatabaseMasterUserPassword")!;
    expect(JSON.parse(sent.body)).toEqual({
      relationalDatabaseName: awsResourceName("database", RID),
      passwordVersion: "CURRENT",
    });
  });

  it("refuses a database that is not active and a bad id before any call (R16)", async () => {
    const { aws, input } = setup();
    await expect(fetchDatabasePassword(input({ resourceState: "stopped" }))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(fetchDatabasePassword(input({ resourceId: "../x" }))).rejects.toMatchObject({
      code: "validation",
    });
    expect(aws.seen.filter((s) => s.service === "lightsail")).toEqual([]);
  });

  it("has no secret in the console, in an error or in a response without a password", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetRelationalDatabaseMasterUserPassword",
      lightsailOk({ masterUserPassword: SECRET }),
    );
    await fetchDatabasePassword(input());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
    const empty = setup();
    empty.aws.on("lightsail", "GetRelationalDatabaseMasterUserPassword", lightsailOk({}));
    await expect(fetchDatabasePassword(empty.input())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });
});

describe("listBucketAccessKeys", () => {
  it("returns key ids, status and creation date only, never a secret", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailOk({
        accessKeys: [
          {
            accessKeyId: "AKIAFAKEKEYONE0001",
            secretAccessKey: "must-not-come-through",
            status: "Active",
            createdAt: 1_700_000_000,
          },
          { accessKeyId: "AKIAFAKEKEYTWO0002", status: "Inactive" },
          { secretAccessKey: "no-id" },
        ],
      }),
    );
    const keys = await listBucketAccessKeys(input());
    expect(keys.map((k) => k.accessKeyId)).toEqual(["AKIAFAKEKEYONE0001", "AKIAFAKEKEYTWO0002"]);
    expect(JSON.stringify(keys)).not.toContain("must-not-come-through");
    expect(keys[0]).toMatchObject({ status: "active" });
    expect(keys[1]).toMatchObject({ status: "inactive" });
  });

  it("maps a not found without the text of AWS", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetBucketAccessKeys",
      lightsailError(400, "NotFoundException", "arn:aws:x 210987654321"),
    );
    await expect(listBucketAccessKeys(input())).rejects.toMatchObject({ code: "not_found" });
  });
});
