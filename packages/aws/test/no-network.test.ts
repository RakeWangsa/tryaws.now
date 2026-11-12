import https from "node:https";
import net from "node:net";
import { GetRegionsCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { expect, it, vi } from "vitest";
import { blockedConnections, isNetworkGuardInstalled } from "./network-guard";
import { fakeAws, lightsailOk } from "./fake-aws";

it("no TCP connection can leave the test process", async () => {
  expect(() => net.connect(443, "lightsail.ap-southeast-1.amazonaws.com")).toThrow(
    /network blocked/,
  );
  expect(() => https.request("https://sts.ap-southeast-1.amazonaws.com/").end()).toThrow(
    /network blocked/,
  );
  await expect(fetch("https://example.com/")).rejects.toMatchObject({
    cause: { code: "ERR_TC_NETWORK_BLOCKED" },
  });
});

it("a real SDK client with its real transport cannot reach AWS", async () => {
  blockedConnections.length = 0;
  const client = new LightsailClient({ region: "ap-southeast-1", maxAttempts: 1 });
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "ERR_TC_NETWORK_BLOCKED",
  });
  expect(blockedConnections).toEqual(["lightsail.ap-southeast-1.amazonaws.com:443"]);
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

it("records what was refused for a Unix socket and for an IPv6 host", () => {
  blockedConnections.length = 0;
  expect(() => net.connect({ path: "/tmp/tc-no-such.sock" })).toThrow(/network blocked/);
  expect(() => net.connect(443, "2600:1f18::1")).toThrow(/network blocked/);
  expect(blockedConnections).toEqual(["unix:/tmp/tc-no-such.sock", "[2600:1f18::1]:443"]);
});

it("the fake refuses a host it does not know, loudly", async () => {
  const aws = fakeAws();
  const client = new LightsailClient({
    region: "ap-south-1",
    endpoint: "https://ec2.amazonaws.com",
    requestHandler: aws.handler,
    maxAttempts: 1,
  });
  await expect(client.send(new GetRegionsCommand({}))).rejects.toThrow(
    "fake-aws: unknown service host ec2.amazonaws.com",
  );
  expect(aws.seen).toEqual([]);
});

it("the fake refuses to load when the guard is not installed", async () => {
  const guard = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    throw new Error("stand-in for a missing guard");
  } as typeof net.Socket.prototype.connect;
  try {
    vi.resetModules();
    await expect(import("./fake-aws")).rejects.toThrow(/need the network guard/);
  } finally {
    net.Socket.prototype.connect = guard;
    vi.resetModules();
  }
  expect(isNetworkGuardInstalled()).toBe(true);
});
