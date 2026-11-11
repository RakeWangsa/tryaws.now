import { awsResourceName } from "@tc/core";
import { describe, expect, it, vi } from "vitest";
import { createAwsAccessInternal } from "../access";
import { fetchWindowsPassword } from "../adapters/windows-access";
import { ASSUMED, assumeRoleOk, fakeAws, leakText, lightsailError, lightsailOk } from "./fake-aws";

const RID = "11111111-2222-4333-8444-555555555555";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const INSTANCE = awsResourceName("instance", RID);
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const SECRET = "tc-test-windows-password-value-123";

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

const details = (over: Record<string, unknown> = {}) =>
  lightsailOk({
    accessDetails: {
      instanceName: INSTANCE,
      protocol: "rdp",
      username: "Administrator",
      password: SECRET,
      ...over,
    },
  });

describe("fetchWindowsPassword", () => {
  it("asks for the rdp access details of the generated name and returns user and password", async () => {
    const { aws, input } = setup();
    aws.on("lightsail", "GetInstanceAccessDetails", details());
    const r = await fetchWindowsPassword(input());
    expect(r).toEqual({ username: "Administrator", password: SECRET });
    const sent = JSON.parse(aws.seen.find((s) => s.action === "GetInstanceAccessDetails")!.body);
    expect(sent).toEqual({ instanceName: INSTANCE, protocol: "rdp" });
    expect(aws.seen.map((s) => s.body).join("\n")).not.toContain(SECRET);
  });

  it("never downloads the default key pair", async () => {
    const { aws, input } = setup();
    aws.on("lightsail", "GetInstanceAccessDetails", details());
    await fetchWindowsPassword(input());
    expect(aws.seen.map((s) => s.action)).not.toContain("DownloadDefaultKeyPair");
  });

  it("refuses an instance that is not active, without calling Lightsail (R16)", async () => {
    const { aws, input } = setup();
    for (const resourceState of ["suspended", "creating", "destroyed", "failed", "stopped"]) {
      await expect(fetchWindowsPassword(input({ resourceState }))).rejects.toMatchObject({
        code: "conflict",
      });
    }
    expect(aws.seen.filter((s) => s.service === "lightsail")).toEqual([]);
  });

  it("fails on a resource id that is not a platform id", async () => {
    const { aws, input } = setup();
    await expect(fetchWindowsPassword(input({ resourceId: "../x" }))).rejects.toBeDefined();
    expect(aws.seen.filter((s) => s.service === "lightsail")).toEqual([]);
  });

  it("a response without a password (still being generated) is not an answer", async () => {
    const first = setup();
    first.aws.on("lightsail", "GetInstanceAccessDetails", details({ password: "" }));
    await expect(fetchWindowsPassword(first.input())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    const second = setup();
    second.aws.on(
      "lightsail",
      "GetInstanceAccessDetails",
      details({ password: undefined, username: undefined }),
    );
    await expect(fetchWindowsPassword(second.input())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("an encrypted password (a custom key pair) is refused: the platform never holds that key", async () => {
    const { aws, input } = setup();
    aws.on(
      "lightsail",
      "GetInstanceAccessDetails",
      details({ password: undefined, passwordData: { ciphertext: "AAAA", keyPairName: "x" } }),
    );
    await expect(fetchWindowsPassword(input())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("writes nothing to the console and no error carries the password or AWS text", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const ok = setup();
    ok.aws.on("lightsail", "GetInstanceAccessDetails", details());
    await fetchWindowsPassword(ok.input());
    const bad = setup();
    bad.aws.on(
      "lightsail",
      "GetInstanceAccessDetails",
      lightsailError(400, "AccessDeniedException", `arn:aws:x 210987654321 ${SECRET}`),
    );
    const error = await fetchWindowsPassword(bad.input()).catch((e: unknown) => e);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
    expect(leakText(error)).not.toMatch(/arn:|210987654321/);
    expect(leakText(error)).not.toContain(SECRET);
  });
});
