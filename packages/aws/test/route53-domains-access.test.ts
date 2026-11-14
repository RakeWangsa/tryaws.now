import { GetOperationDetailCommand } from "@aws-sdk/client-route-53-domains";
import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createRoute53DomainsPort } from "../domains-client";
import { AwsError } from "../errors";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError as jsonError,
  lightsailOk as jsonOk,
  stsError,
} from "./fake-aws";

// WPU-X10: the Route 53 Domains client of the tc-dns account, reached like route53(): STS AssumeRole with the
// ExternalId, one endpoint in us-east-1, the same credential cache, and only for callers whose list has the role (R3).

const DNS = { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" };
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

function setup<C extends "provisioner" | "reader" | "catalog-sync" | "access-details">(caller: C) {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  return { aws, access: createAwsAccessInternal({ caller, clock, requestHandler: aws.handler }) };
}

it("signs Route 53 Domains calls with the assumed TcDnsProvisioner role, to the us-east-1 endpoint", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("route53domains", "GetOperationDetail", jsonOk({ Status: "SUCCESSFUL" }));
  const client = access.route53Domains(DNS, "TcDnsProvisioner");
  await client.send(new GetOperationDetailCommand({ OperationId: "op-1" }));
  const call = aws.seen.find((r) => r.service === "route53domains")!;
  expect(call.host).toBe("route53domains.us-east-1.amazonaws.com");
  expect(call.authorization).toContain("Credential=tc-test-assumed-key-1/");
  expect(call.authorization).toContain("/us-east-1/route53domains/");
  const sts = aws.seen.find((r) => r.service === "sts")!;
  expect(sts.body).toContain("TcDnsProvisioner");
  expect(sts.body).toContain("123456789012");
  expect(sts.body).toContain("tc-ext-11aa22");
});

it("returns one client per account and role, and one session serves several calls", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("route53domains", "GetOperationDetail", jsonOk({ Status: "IN_PROGRESS" }));
  const a = access.route53Domains(DNS, "TcDnsProvisioner");
  expect(access.route53Domains({ ...DNS }, "TcDnsProvisioner")).toBe(a);
  const port = createRoute53DomainsPort(a);
  expect(await port.getOperationDetail("op-1")).toEqual({ status: "in_progress" });
  await port.getOperationDetail("op-1");
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(1);
});

it("keeps the Route 53 Domains meaning of a refusal through the access client (DuplicateRequest is a conflict)", async () => {
  const { aws, access } = setup("provisioner");
  aws.on(
    "route53domains",
    "RegisterDomain",
    jsonError(400, "DuplicateRequest", "The request is already in progress for shop.com"),
  );
  const port = createRoute53DomainsPort(access.route53Domains(DNS, "TcDnsProvisioner"));
  const error = await port
    .registerDomain({
      name: "shop.com",
      years: 1,
      maxPriceUsd: "15",
      contact: {
        contactType: "PERSON",
        firstName: "A",
        lastName: "B",
        email: "a@example.com",
        phoneNumber: "+880.1711000000",
        addressLine1: "Road 1",
        city: "Dhaka",
        state: "Dhaka",
        countryCode: "BD",
        zipCode: "1212",
      },
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({
    code: "conflict",
    retryable: true,
    awsErrorName: "DuplicateRequest",
    operation: "RegisterDomain",
    mayHaveActed: false,
  });
  expectNoLeak(error);
});

it("a name outside the account is null through the real error path (InvalidInput on GetDomainDetail)", async () => {
  const { aws, access } = setup("provisioner");
  aws.on(
    "route53domains",
    "GetDomainDetail",
    jsonError(400, "InvalidInput", "Domain none.com not found in account 123456789012"),
  );
  const port = createRoute53DomainsPort(access.route53Domains(DNS, "TcDnsProvisioner"));
  expect(await port.getDomainDetail("none.com")).toBeNull();
});

it("an access denied drops the session, so the next call assumes the role again; no AWS text leaves", async () => {
  const { aws, access } = setup("provisioner");
  aws.on(
    "route53domains",
    "GetOperationDetail",
    jsonError(
      403,
      "AccessDeniedException",
      "User: arn:aws:sts::123456789012:assumed-role/TcDnsProvisioner/x is not authorized",
    ),
    jsonOk({ Status: "SUCCESSFUL" }),
  );
  const port = createRoute53DomainsPort(access.route53Domains(DNS, "TcDnsProvisioner"));
  const error = await port.getOperationDetail("op-1").catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "forbidden" });
  expectNoLeak(error);
  expect(await port.getOperationDetail("op-1")).toEqual({ status: "successful" });
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(2);
});

it("a failed AssumeRole is a platform error and no Route 53 Domains call is made", async () => {
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
  const port = createRoute53DomainsPort(access.route53Domains(DNS, "TcDnsProvisioner"));
  const error = await port.getOperationDetail("op-1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expectNoLeak(error);
  expect(aws.seen.filter((r) => r.service === "route53domains")).toHaveLength(0);
});

it("a caller gets only the DNS roles of its own list", () => {
  expect(() => setup("provisioner").access.route53Domains(DNS, "TcDnsProvisioner")).not.toThrow();
  expect(() => setup("catalog-sync").access.route53Domains(DNS, "TcDnsReader")).not.toThrow();
  expect(() =>
    // @ts-expect-error catalog-sync may not use the provisioner role
    setup("catalog-sync").access.route53Domains(DNS, "TcDnsProvisioner"),
  ).toThrow(/role_not_allowed/);
  expect(() =>
    // @ts-expect-error access-details has no DNS role
    setup("access-details").access.route53Domains(DNS, "TcDnsReader"),
  ).toThrow(/role_not_allowed/);
  expect(() => setup("provisioner").access.route53Domains(DNS, "TcProvisioner" as never)).toThrow(
    /role_not_allowed/,
  );
});

it("refuses a bad account reference before any request", () => {
  const { aws, access } = setup("provisioner");
  expect(() =>
    access.route53Domains({ awsAccountId: "tc-dns", externalId: "tc-dns" }, "TcDnsProvisioner"),
  ).toThrow(/account_ref_invalid/);
  expect(aws.seen).toHaveLength(0);
});
