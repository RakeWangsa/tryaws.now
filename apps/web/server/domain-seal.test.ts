import type { EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";
import {
  DOMAIN_CONTACT_CONTEXT,
  MAX_CONTACT_BYTES,
  contactSealFromClient,
  contactSealFromEnv,
} from "./domain-seal.ts";

// WPU-X10: the web tier seals the registrant contact with KMS Encrypt under the domain-contact key and the fixed
// context that the provisioner's Decrypt checks. Fail closed without a key (R16); no contact or AWS text leaks (R14).

const KEY = "arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const CONTACT = JSON.stringify({ firstName: "Rahim", email: "rahim@example.com" });

function fakeKms(answer: (command: EncryptCommand) => Promise<{ CiphertextBlob?: Uint8Array }>) {
  const sent: EncryptCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: EncryptCommand) => {
        sent.push(command);
        return answer(command);
      },
    },
  };
}

describe("contactSealFromClient", () => {
  it("encrypts with the key and the domain-contact context and answers the ciphertext", async () => {
    const kms = fakeKms(async () => ({ CiphertextBlob: new Uint8Array([7, 7, 7]) }));
    const sealed = await contactSealFromClient(kms.client, KEY)(CONTACT);
    expect([...sealed]).toEqual([7, 7, 7]);
    const input = kms.sent[0]!.input;
    expect(input.KeyId).toBe(KEY);
    expect(input.EncryptionContext).toEqual({ "tc:purpose": "domain-contact" });
    expect(DOMAIN_CONTACT_CONTEXT).toEqual({ "tc:purpose": "domain-contact" });
  });

  it("refuses an empty or oversized contact before any call", async () => {
    const kms = fakeKms(async () => ({ CiphertextBlob: new Uint8Array([1]) }));
    const seal = contactSealFromClient(kms.client, KEY);
    await expect(seal("")).rejects.toThrow(/could not be sealed/);
    await expect(seal("x".repeat(MAX_CONTACT_BYTES + 1))).rejects.toThrow(/could not be sealed/);
    expect(kms.sent).toHaveLength(0);
  });

  it("a refused Encrypt or an empty answer is one fixed message without AWS or contact text", async () => {
    const denied = fakeKms(async () => {
      throw new Error("User: arn:aws:sts::123456789012:assumed-role/web is not authorized");
    });
    const error = await contactSealFromClient(denied.client, KEY)(CONTACT).catch((e: unknown) => e);
    expect(String((error as Error).message)).toBe("domain-seal: the contact could not be sealed");
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toMatch(
      /arn:|123456789012|Rahim|rahim@/,
    );
    const empty = fakeKms(async () => ({}));
    await expect(contactSealFromClient(empty.client, KEY)(CONTACT)).rejects.toThrow(
      /could not be sealed/,
    );
  });
});

describe("contactSealFromEnv", () => {
  it.each([
    {},
    { DOMAIN_CONTACT_KEY_ARN: "" },
    { DOMAIN_CONTACT_KEY_ARN: "alias/tc-staging-domain-contact" },
    { DOMAIN_CONTACT_KEY_ARN: `${KEY}\n` },
  ])("is null (the draft is refused, R16) for %j", (env) => {
    expect(contactSealFromEnv(env, () => fakeKms(async () => ({})).client)).toBeNull();
  });

  it("builds the client lazily, in the Region of the key", async () => {
    const regions: string[] = [];
    const kms = fakeKms(async () => ({ CiphertextBlob: new Uint8Array([1]) }));
    const seal = contactSealFromEnv({ DOMAIN_CONTACT_KEY_ARN: KEY }, (region) => {
      regions.push(region);
      return kms.client;
    });
    expect(regions).toEqual([]);
    await seal!(CONTACT);
    await seal!(CONTACT);
    expect(regions).toEqual(["ap-southeast-1"]);
    expect(kms.sent).toHaveLength(2);
  });
});
