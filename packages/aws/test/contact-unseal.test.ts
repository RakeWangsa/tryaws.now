import { DecryptCommand } from "@aws-sdk/client-kms";
import { expect, it } from "vitest";
import { createContactUnseal, createKmsClient, DOMAIN_CONTACT_CONTEXT } from "../contact-unseal";
import { AwsError } from "../errors";
import { expectNoLeak } from "./fake-aws";

// WPU-X10: the provisioner opens the sealed registrant contact with KMS Decrypt, pinned to the domain-contact key
// and to the encryption context that the web seal binds.

const KEY = "arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const CONTACT = { contactType: "PERSON", firstName: "Rahim", email: "rahim@example.com" };

function fakeKms(answer: () => Promise<{ Plaintext?: Uint8Array }>) {
  const sent: DecryptCommand[] = [];
  return {
    sent,
    client: {
      async send(command: DecryptCommand) {
        sent.push(command);
        return answer();
      },
    },
  };
}

const plain = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it("decrypts with the pinned key and the domain-contact context, and answers the JSON value", async () => {
  const kms = fakeKms(async () => ({ Plaintext: plain(CONTACT) }));
  const unseal = createContactUnseal(kms.client, KEY);
  const sealed = new Uint8Array([1, 2, 3, 4]);
  expect(await unseal(sealed)).toEqual(CONTACT);
  expect(kms.sent).toHaveLength(1);
  const input = kms.sent[0]!.input;
  expect(input.KeyId).toBe(KEY);
  expect(input.EncryptionContext).toEqual({ "tc:purpose": "domain-contact" });
  expect(input.CiphertextBlob).toBe(sealed);
  expect(DOMAIN_CONTACT_CONTEXT).toEqual({ "tc:purpose": "domain-contact" });
});

it("zeroes the plaintext buffer after reading it", async () => {
  const buffer = plain(CONTACT);
  const unseal = createContactUnseal(fakeKms(async () => ({ Plaintext: buffer })).client, KEY);
  await unseal(new Uint8Array([9]));
  expect(buffer.every((b) => b === 0)).toBe(true);
});

it("fails closed without a valid key ARN, before any request (R16)", async () => {
  for (const bad of [undefined, "", "alias/tc-staging-domain-contact", `${KEY}\n`, 42]) {
    const kms = fakeKms(async () => ({ Plaintext: plain(CONTACT) }));
    const error = await createContactUnseal(
      kms.client,
      bad,
    )(new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({ code: "internal", reason: "not_configured" });
    expect(kms.sent).toHaveLength(0);
  }
});

it("a refused or broken decrypt is a fixed error without AWS or contact text (R14)", async () => {
  const denied = createContactUnseal(
    fakeKms(async () => {
      throw Object.assign(
        new Error("User arn:aws:sts::123456789012:assumed-role/x is not authorized"),
        {
          name: "AccessDeniedException",
        },
      );
    }).client,
    KEY,
  );
  const error = await denied(new Uint8Array([1])).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "internal", retryable: false, operation: "Decrypt" });
  expectNoLeak(error);

  const throttled = createContactUnseal(
    fakeKms(async () => {
      throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    }).client,
    KEY,
  );
  await expect(throttled(new Uint8Array([1]))).rejects.toMatchObject({ retryable: true });

  const notJson = createContactUnseal(
    fakeKms(async () => ({ Plaintext: new TextEncoder().encode("rahim@example.com") })).client,
    KEY,
  );
  const parseError = await notJson(new Uint8Array([1])).catch((e: unknown) => e);
  expect(parseError).toBeInstanceOf(AwsError);
  expect(String((parseError as Error).message)).not.toContain("rahim");

  const empty = createContactUnseal(fakeKms(async () => ({})).client, KEY);
  await expect(empty(new Uint8Array([1]))).rejects.toBeInstanceOf(AwsError);
  await expect(empty(new Uint8Array([]))).rejects.toBeInstanceOf(AwsError);
});

it("the KMS client refuses a malformed Region and has no logger", () => {
  expect(() => createKmsClient("")).toThrow(/not_configured/);
  expect(() => createKmsClient("ap-southeast-1\n")).toThrow(/not_configured/);
  const client = createKmsClient("ap-southeast-1");
  expect(client.config.logger).not.toHaveProperty("info", console.info);
});
