import { GetHostedZoneCommand } from "@aws-sdk/client-route-53";
import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createRoute53Port } from "../adapters/route53-client";
import { AwsError } from "../errors";
import { ASSUMED, assumeRoleOk, expectNoLeak, fakeAws, route53Xml, stsError } from "./fake-aws";

// WPU-D4: the Route 53 client of the tc-dns account is reached by STS AssumeRole with the ExternalId,
// through one global endpoint, and only by the callers whose role list has a DNS role (R3).

const DNS = { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" };
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const NS = "https://route53.amazonaws.com/doc/2013-04-01/";
const ZONE_PATH = "GET /2013-04-01/hostedzone/Z0TESTZONE1";

function setup<C extends "provisioner" | "reader" | "access-details">(caller: C) {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  return { aws, access: createAwsAccessInternal({ caller, clock, requestHandler: aws.handler }) };
}

const zoneXml = (id: string) =>
  `<GetHostedZoneResponse xmlns="${NS}"><HostedZone><Id>/hostedzone/${id}</Id><Name>shop.example.</Name>` +
  `<CallerReference>r</CallerReference></HostedZone><DelegationSet><NameServers>` +
  ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"]
    .map((n) => `<NameServer>${n}</NameServer>`)
    .join("") +
  `</NameServers></DelegationSet></GetHostedZoneResponse>`;

it("signs Route 53 calls with the assumed TcDnsProvisioner role, to the global endpoint", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("route53", ZONE_PATH, route53Xml(200, zoneXml("Z0TESTZONE1")));
  const client = access.route53(DNS, "TcDnsProvisioner");
  await client.send(new GetHostedZoneCommand({ Id: "Z0TESTZONE1" }));
  const call = aws.seen.find((r) => r.service === "route53")!;
  expect(call.host).toBe("route53.amazonaws.com");
  expect(call.authorization).toContain("Credential=tc-test-assumed-key-1/");
  expect(call.authorization).toContain("/us-east-1/route53/");
  const sts = aws.seen.find((r) => r.service === "sts")!;
  expect(sts.body).toContain("TcDnsProvisioner");
  expect(sts.body).toContain("123456789012");
  expect(sts.body).toContain("tc-ext-11aa22");
});

it("a port over the access client answers a zone and caches one session", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("route53", ZONE_PATH, route53Xml(200, zoneXml("Z0TESTZONE1")));
  const port = createRoute53Port(access.route53(DNS, "TcDnsProvisioner"));
  expect(await port.getHostedZone("Z0TESTZONE1")).toEqual({
    id: "Z0TESTZONE1",
    name: "shop.example.",
    nameServers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"],
  });
  await port.getHostedZone("Z0TESTZONE1");
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(1);
});

it("a missing zone is null through the real error path, and an access denied is a platform error without AWS text", async () => {
  const { aws, access } = setup("provisioner");
  const port = createRoute53Port(access.route53(DNS, "TcDnsProvisioner"));
  const err = (code: string, message: string) =>
    `<ErrorResponse xmlns="${NS}"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>r</RequestId></ErrorResponse>`;
  aws.on(
    "route53",
    ZONE_PATH,
    route53Xml(404, err("NoSuchHostedZone", "No hosted zone found with ID: Z0TESTZONE1")),
  );
  expect(await port.getHostedZone("Z0TESTZONE1")).toBeNull();
  aws.on(
    "route53",
    ZONE_PATH,
    route53Xml(
      403,
      err(
        "AccessDenied",
        "User: arn:aws:sts::123456789012:assumed-role/TcDnsProvisioner/x is not authorized",
      ),
    ),
  );
  const error = await port.getHostedZone("Z0TESTZONE1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "forbidden" });
  expectNoLeak(error);
});

it("a failed AssumeRole is a platform error and no Route 53 call is made", async () => {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    stsError(403, "AccessDenied", "not authorized to perform sts:AssumeRole"),
  );
  const access = createAwsAccessInternal({
    caller: "provisioner",
    clock,
    requestHandler: aws.handler,
  });
  const port = createRoute53Port(access.route53(DNS, "TcDnsProvisioner"));
  const error = await port.getHostedZone("Z0TESTZONE1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(aws.seen.filter((r) => r.service === "route53")).toHaveLength(0);
});

it("a caller gets only the DNS roles of its own list", () => {
  expect(() => setup("provisioner").access.route53(DNS, "TcDnsProvisioner")).not.toThrow();
  expect(() => setup("reader").access.route53(DNS, "TcDnsReader")).not.toThrow();
  // @ts-expect-error the reader may not use the provisioner role
  expect(() => setup("reader").access.route53(DNS, "TcDnsProvisioner")).toThrow(/role_not_allowed/);
  // @ts-expect-error access-details has no DNS role
  expect(() => setup("access-details").access.route53(DNS, "TcDnsReader")).toThrow(
    /role_not_allowed/,
  );
  expect(() => setup("provisioner").access.route53(DNS, "TcProvisioner" as never)).toThrow(
    /role_not_allowed/,
  );
});

it("refuses a bad account reference before any request", () => {
  const { aws, access } = setup("provisioner");
  expect(() =>
    access.route53({ awsAccountId: "tc-dns", externalId: "tc-dns" }, "TcDnsProvisioner"),
  ).toThrow(/account_ref_invalid/);
  expect(aws.seen).toHaveLength(0);
});
