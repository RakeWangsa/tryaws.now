import { AwsError, type AwsAccess } from "@tc/aws";
import { describe, expect, it } from "vitest";
import { dnsZonePortsFromEnv } from "./dns-zone";

// WPU-D4: the Route 53 port of the provisioner is built from the environment of the Lambda (the tc-dns
// account id and its ExternalId, both plain values, 6.3) and the role TcDnsProvisioner. Without a valid
// environment it fails closed with a fixed local error and makes no call (R16).

const ENV = { TC_DNS_ACCOUNT_ID: "123456789012", TC_DNS_EXTERNAL_ID: "tc-ext-11aa22" };

function stubAccess() {
  const calls: { account: unknown; role: string }[] = [];
  const access = {
    caller: "provisioner",
    lightsail: () => {
      throw new Error("not used");
    },
    route53: (account: unknown, role: string) => {
      calls.push({ account, role });
      return {
        send: async () => {
          throw new Error("no network in this test");
        },
      };
    },
  } as unknown as AwsAccess<"provisioner">;
  return { access, calls };
}

describe("dnsZonePortsFromEnv", () => {
  it("builds the port from the tc-dns account and the provisioner role, lazily", () => {
    const { access, calls } = stubAccess();
    const ports = dnsZonePortsFromEnv(ENV, access);
    expect(calls).toHaveLength(0);
    const port = ports.route53();
    expect(typeof port.createHostedZone).toBe("function");
    expect(calls).toEqual([
      {
        account: { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" },
        role: "TcDnsProvisioner",
      },
    ]);
  });

  it.each([
    {},
    { TC_DNS_ACCOUNT_ID: "123456789012" },
    { TC_DNS_EXTERNAL_ID: "tc-ext-11aa22" },
    { ...ENV, TC_DNS_ACCOUNT_ID: "tc-dns" },
    { ...ENV, TC_DNS_ACCOUNT_ID: "123456789012\n" },
    { ...ENV, TC_DNS_EXTERNAL_ID: "" },
    { ...ENV, TC_DNS_EXTERNAL_ID: "bad id" },
  ])("fails closed with a fixed local error and no call for %j", (env) => {
    const { access, calls } = stubAccess();
    const ports = dnsZonePortsFromEnv(env, access);
    expect(() => ports.route53()).toThrow(AwsError);
    expect(() => ports.route53()).toThrow(/not_configured/);
    expect(calls).toHaveLength(0);
  });

  it("does not put the ExternalId or the account id in the error", () => {
    const { access } = stubAccess();
    const error = (() => {
      try {
        dnsZonePortsFromEnv({ ...ENV, TC_DNS_ACCOUNT_ID: "bad" }, access).route53();
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(JSON.stringify(error) + String((error as Error).message)).not.toMatch(
      /tc-ext-11aa22|123456789012/,
    );
  });
});
