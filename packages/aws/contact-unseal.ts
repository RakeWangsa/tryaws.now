import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { AwsError } from "./errors";
import { TIME_LIMITS } from "./settings";
import type { AwsRequestHandler } from "./types";

// WPU-X10: the unseal of the registrant contact of a domain draft (JOURNEY Needs decision 2 of WP7-T4). The web app
// seals the contact JSON with KMS Encrypt under the domain-contact key of the stage (alias tc-<stage>-domain-contact,
// infra/stacks/storage.ts) and the encryption context below (apps/web/server/domain-seal.ts); only the provisioner
// role may Decrypt with that key (infra/stacks/workers.ts). The key lives in the control-plane account, so the KMS
// client uses the function's own role: no AssumeRole (R3).
//
// Nothing of the contact, of the ciphertext or of an AWS error leaves this file (R14, U6): a failure is a fixed
// AwsError and the domain adapter turns it into "internal" (contactOf of adapters/domain.ts).

/** Bound into every seal and checked by every unseal: a ciphertext made for another purpose does not open. */
export const DOMAIN_CONTACT_CONTEXT: Readonly<Record<string, string>> = Object.freeze({
  "tc:purpose": "domain-contact",
});

// A symmetric key ARN of KMS (no alias: Decrypt is pinned to this exact key).
const KMS_KEY_ARN =
  /^arn:aws:kms:[a-z]{2}(-[a-z]+)+-\d:[0-9]{12}:key\/(mrk-)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** True for a KMS key ARN (not an alias, no trailing newline). */
export function isKmsKeyArn(value: unknown): value is string {
  return typeof value === "string" && KMS_KEY_ARN.test(value);
}

/** The one method of the SDK client used here; tests pass a fake. */
export interface KmsDecryptSender {
  send(command: DecryptCommand): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

function notConfigured(): AwsError {
  return new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
}

function unsealFailed(retryable: boolean): AwsError {
  return new AwsError({ code: "internal", retryable, operation: "Decrypt", mayHaveActed: false });
}

/**
 * `(sealed) => contact JSON value`. The adapter parses the value with parseRegistrantContact; here only JSON is
 * read. A missing or malformed key ARN refuses every call (R16) without a request.
 */
export function createContactUnseal(
  client: KmsDecryptSender,
  keyArn: unknown,
): (sealed: Uint8Array) => Promise<unknown> {
  const key = isKmsKeyArn(keyArn) ? keyArn : null;
  return async (sealed) => {
    if (key === null) throw notConfigured();
    if (!(sealed instanceof Uint8Array) || sealed.length === 0 || sealed.length > 6144) {
      throw unsealFailed(false);
    }
    let plaintext: Uint8Array | undefined;
    try {
      const response = await client.send(
        new DecryptCommand({
          CiphertextBlob: sealed,
          KeyId: key,
          EncryptionContext: { ...DOMAIN_CONTACT_CONTEXT },
        }),
      );
      plaintext = response.Plaintext;
    } catch (error) {
      // A wrong key, a wrong context or a broken blob is final; throttling or a network fault may pass.
      const name =
        typeof error === "object" && error !== null && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      throw unsealFailed(
        !/^(InvalidCiphertextException|IncorrectKeyException|AccessDeniedException|NotFoundException|DisabledException|KMSInvalidStateException)$/.test(
          name,
        ),
      );
    }
    if (!(plaintext instanceof Uint8Array)) throw unsealFailed(true);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
    } catch {
      throw unsealFailed(false);
    } finally {
      plaintext.fill(0);
    }
  };
}

/**
 * The KMS client of the function's own account and Region (AWS_REGION of the Lambda). No `logger` (R14); the time
 * limits of every client of this package.
 */
export function createKmsClient(region: string, requestHandler?: AwsRequestHandler): KMSClient {
  if (typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw notConfigured();
  }
  return new KMSClient({
    region,
    maxAttempts: 3,
    retryMode: "standard",
    requestHandler: requestHandler ?? { ...TIME_LIMITS },
  });
}
