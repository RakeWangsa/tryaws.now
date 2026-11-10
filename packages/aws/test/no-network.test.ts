import https from "node:https";
import net from "node:net";
import { GetRegionsCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { expect, it } from "vitest";
import { blockedConnections, isNetworkGuardInstalled } from "./network-guard";
import { fakeAws, lightsailOk } from "./fake-aws";

it("no TCP connection can leave the test process", async () => {
  expect(() => net.connect(443, "lightsail.ap-southeast-1.amazonaws.com")).toThrow(
    /network blocked/,
  );
  expect(() => https.request("https://sts.ap-southeast-1.amazonaws.com/").end()).toThrow(
    /network blocked/,
  );
  await expect(fetch("https://example.com/")).rejects.toThrow();
});

it("a real SDK client with its real transport cannot reach AWS", async () => {
  const client = new LightsailClient({ region: "ap-southeast-1", maxAttempts: 1 });
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "ERR_TC_NETWORK_BLOCKED",
  });
  expect(blockedConnections).toContain("lightsail.ap-southeast-1.amazonaws.com:443");
});

it("the setup file replaces the developer's AWS environment", () => {
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-base-access-key");
  expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBe("/nonexistent/tc-aws-test");
  expect(process.env.AWS_PROFILE).toBeUndefined();
  expect(isNetworkGuardInstalled()).toBe(true);
});

it("the fake transport answers in process and records what it saw", async () => {
  const aws = fakeAws();
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  const client = new LightsailClient({ region: "ap-south-1", requestHandler: aws.handler });
  await expect(client.send(new GetRegionsCommand({}))).resolves.toMatchObject({ regions: [] });
  expect(aws.seen).toHaveLength(1);
  expect(aws.seen[0]).toMatchObject({
    service: "lightsail",
    host: "lightsail.ap-south-1.amazonaws.com",
    action: "GetRegions",
  });
  expect(aws.seen[0]!.authorization).toContain("Credential=test-base-access-key/");
});
