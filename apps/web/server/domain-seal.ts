import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

// WPU-X10: the KMS seal of the registrant contact of a domain draft (DomainDraftDeps.seal; JOURNEY Needs decision 2
// of WP7-T4, resolved by WPU-X10). KMS Encrypt with the domain-contact key of the stage (alias
// tc-<stage>-domain-contact, infra/stacks/storage.ts) and a fixed encryption context. The web role may Encrypt with
// that key and nothing else (no Decrypt, no GenerateDataKey: infra/stacks/web.ts); only the provisioner role may
// Decrypt (packages/aws/contact-unseal.ts, the same context). R1: this is KMS of the function's own account with the
// default credential chain of its role, no AssumeRole and no import of packages/aws (R3).
//
// Fail closed (R16): a missing or malformed key ARN gives no seal (the draft is refused as "unavailable"); a refused
// or failed Encrypt throws one fixed message. Nothing of the contact or of the AWS error leaves this file (R14).

/** The same context as DOMAIN_CONTACT_CONTEXT of packages/aws/contact-unseal.ts (pinned by a repo test). */
export const DOMAIN_CONTACT_CONTEXT: Readonly<Record<string, string>> = Object.freeze({
  "tc:purpose": "domain-contact",
});

/** A KMS key ARN of the stage (not an alias): the seal is pinned to this exact key. */
export const DOMAIN_CONTACT_KEY_PATTERN =
  /^arn:aws:kms:[a-z]{2}(-[a-z]+)+-\d:[0-9]{12}:key\/(mrk-)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** KMS Encrypt takes at most 4096 bytes of plaintext. A larger contact is refused here, before any call. */
export const MAX_CONTACT_BYTES = 4096;

const FAILED = "domain-seal: the contact could not be sealed";

/** The one call of the SDK client used here; a test passes a fake. */
export interface KmsEncryptSender {
  send(command: EncryptCommand): Promise<{ CiphertextBlob?: Uint8Array | undefined }>;
}

export function contactSealFromClient(
  client: KmsEncryptSender,
  keyArn: string,
): (plaintext: string) => Promise<Uint8Array> {
  return async (plaintext) => {
    const bytes = new TextEncoder().encode(plaintext);
    if (bytes.length === 0 || bytes.length > MAX_CONTACT_BYTES) throw new Error(FAILED);
    let sealed: Uint8Array | undefined;
    try {
      const out = await client.send(
        new EncryptCommand({
          KeyId: keyArn,
          Plaintext: bytes,
          EncryptionContext: { ...DOMAIN_CONTACT_CONTEXT },
        }),
      );
      sealed = out.CiphertextBlob;
    } catch {
      throw new Error(FAILED);
    } finally {
      bytes.fill(0);
    }
    if (!(sealed instanceof Uint8Array) || sealed.length === 0) throw new Error(FAILED);
    return sealed;
  };
}

function kmsClient(region: string): KmsEncryptSender {
  // No logger (R14). One attempt plus two retries of the SDK's standard mode; the customer can submit again.
  return new KMSClient({
    region,
    maxAttempts: 3,
    retryMode: "standard",
    requestHandler: { connectionTimeout: 2000, requestTimeout: 6000, throwOnRequestTimeout: true },
  });
}

/**
 * The seal of this environment, or null when DOMAIN_CONTACT_KEY_ARN is missing or malformed. The client is built on
 * the first call, never at import.
 */
export function contactSealFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  build: (region: string) => KmsEncryptSender = kmsClient,
): ((plaintext: string) => Promise<Uint8Array>) | null {
  const keyArn = env["DOMAIN_CONTACT_KEY_ARN"];
  if (typeof keyArn !== "string" || !DOMAIN_CONTACT_KEY_PATTERN.test(keyArn)) return null;
  // The key and the function live in the same Region of the stage; the ARN names it.
  const region = keyArn.split(":")[3] as string;
  let seal: ((plaintext: string) => Promise<Uint8Array>) | undefined;
  return (plaintext) => {
    seal ??= contactSealFromClient(build(region), keyArn);
    return seal(plaintext);
  };
}
