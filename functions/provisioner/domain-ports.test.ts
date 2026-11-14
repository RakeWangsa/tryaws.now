import { AwsError, type AwsAccess } from "@tc/aws";
import { describe, expect, it } from "vitest";
import { domainPortsFromEnv } from "./domain";

// WPU-X10: the ports of the domain adapter are built from the environment of the Lambda: the tc-dns account and its
// ExternalId (plain values, 6.3) with the role TcDnsProvisioner for Route 53 and Route 53 Domains, and the KMS key
// of the registrant contact. A missing or malformed value fails closed with a fixed local error and no call (R16).

const KEY = "arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const ENV = {
  TC_DNS_ACCOUNT_ID: "123456789012",
  TC_DNS_EXTERNAL_ID: "tc-ext-11aa22",
  TC_DOMAIN_CONTACT_KEY_ARN: KEY,
  AWS_REGION: "ap-southeast-1",
};

function stubAccess() {
  const calls: { client: string; account: unknown; role: string }[] = [];
  const client = (name: string) => (account: unknown, role: string) => {
    calls.push({ client: name, account, role });
    return {
      send: async () => {
        throw new Error("no network in this test");
      },
    };
  };
  const access = {
    caller: "provisioner",
    lightsail: () => {
      throw new Error("not used");
    },
    route53: client("route53"),
    route53Domains: client("route53Domains"),
  } as unknown as AwsAccess<"provisioner">;
  return { access, calls };
}

function stubKms(plaintext: unknown) {
  const sent: { input: unknown }[] = [];
  let built = 0;
  return {
    sent,
    built: () => built,
    factory: () => {
      built += 1;
      return {
        send: async (command: { input: unknown }) => {
          sent.push(command);
          return { Plaintext: new TextEncoder().encode(JSON.stringify(plaintext)) };
        },
      };
    },
  };
}

describe("domainPortsFromEnv", () => {
  it("builds Route 53 and Route 53 Domains of tc-dns with TcDnsProvisioner, lazily", () => {
    const { access, calls } = stubAccess();
    const ports = domainPortsFromEnv(ENV, access, stubKms({}).factory);
    expect(calls).toHaveLength(0);
    expect(typeof ports.domains().registerDomain).toBe("function");
    expect(typeof ports.route53().createHostedZone).toBe("function");
    const account = { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" };
    expect(calls).toEqual([
      { client: "route53Domains", account, role: "TcDnsProvisioner" },
      { client: "route53", account, role: "TcDnsProvisioner" },
    ]);
  });

  it("unseals the contact with the key of the environment", async () => {
    const { access } = stubAccess();
    const kms = stubKms({ firstName: "Rahim" });
    const ports = domainPortsFromEnv(ENV, access, kms.factory);
    expect(kms.built()).toBe(0);
    expect(await ports.unsealContact(new Uint8Array([1, 2]))).toEqual({ firstName: "Rahim" });
    expect(kms.sent[0]!.input).toMatchObject({
      KeyId: KEY,
      EncryptionContext: { "tc:purpose": "domain-contact" },
    });
  });

  it.each([
    {},
    { TC_DNS_ACCOUNT_ID: "123456789012" },
    { TC_DNS_EXTERNAL_ID: "tc-ext-11aa22" },
    { ...ENV, TC_DNS_ACCOUNT_ID: "tc-dns" },
    { ...ENV, TC_DNS_ACCOUNT_ID: "123456789012\n" },
    { ...ENV, TC_DNS_EXTERNAL_ID: "" },
    { ...ENV, TC_DNS_EXTERNAL_ID: "bad id" },
  ])("the DNS ports fail closed with a fixed local error and no call for %j", (env) => {
    const { access, calls } = stubAccess();
    const ports = domainPortsFromEnv(env, access, stubKms({}).factory);
    expect(() => ports.domains()).toThrow(AwsError);
    expect(() => ports.domains()).toThrow(/not_configured/);
    expect(() => ports.route53()).toThrow(/not_configured/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { ...ENV, TC_DOMAIN_CONTACT_KEY_ARN: undefined },
    { ...ENV, TC_DOMAIN_CONTACT_KEY_ARN: "alias/tc-staging-domain-contact" },
    { ...ENV, TC_DOMAIN_CONTACT_KEY_ARN: `${KEY}\n` },
  ])("the unseal fails closed without a valid key ARN and makes no KMS call", async (env) => {
    const { access } = stubAccess();
    const kms = stubKms({});
    const ports = domainPortsFromEnv(env, access, kms.factory);
    await expect(ports.unsealContact(new Uint8Array([1]))).rejects.toMatchObject({
      reason: "not_configured",
    });
    expect(kms.sent).toHaveLength(0);
  });

  it("does not put the ExternalId, the account id or the key in the error", () => {
    const { access } = stubAccess();
    let error: unknown = null;
    try {
      domainPortsFromEnv(
        { ...ENV, TC_DNS_ACCOUNT_ID: "bad" },
        access,
        stubKms({}).factory,
      ).domains();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AwsError);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toMatch(
      /tc-ext-11aa22|123456789012|0f1e2d3c/,
    );
  });
});
