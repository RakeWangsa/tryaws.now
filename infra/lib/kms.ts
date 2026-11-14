// WPU-X10 review fix 1: the key policy of the domain-contact key (infra/stacks/storage.ts). Pure data, tested by
// tests/repo/domain-contact-key.test.mjs.
//
// The default key policy ("Enable IAM User Permissions": the account root may do kms:*) would let any principal whose
// IAM policy holds kms:* on "*" (the CI deploy roles TcCiDeployStaging and TcCiDeployProduction, an operator) decrypt
// every registrant contact. This policy keeps the root statement, so IAM still delegates, but for the administration
// of the key ONLY: no Encrypt, Decrypt, ReEncrypt, GenerateDataKey* and no CreateGrant (a grant could hand Decrypt to
// anyone). The deploy role of a stage reaches these actions through its IAM policy (kms:* there), so it can still
// create, read, update, rotate, tag, alias and delete the key, and the KMS lockout check passes (the caller of
// PutKeyPolicy keeps PutKeyPolicy). A personal stage needs nothing more: its deployer is an IAM principal of the
// account too, so no CI role is named here.
//
// Encrypt is allowed for the web role of the stage only, Decrypt for the provisioner role only, each bound to the
// encryption context of the seal (apps/web/server/domain-seal.ts, packages/aws/contact-unseal.ts). The roles are
// named by aws:PrincipalArn under the root principal, not as principals: a role principal must exist when the policy
// is put, and the function roles are created later in the same deploy (the bucket policy of storage.ts does the
// same). Their IAM policies grant the same action with the same condition (web.ts, workers.ts): both must allow.
//
// Accepted risk: kms:PutKeyPolicy lets an administrator of the account rewrite this policy. That is a logged
// (CloudTrail) change of the key, not a silent read of a contact.
import { roleName } from "./stage";

/** The value of the encryption context key `tc:purpose` of every domain-contact seal. */
export const DOMAIN_CONTACT_PURPOSE = "domain-contact";

/** What the account (and through IAM the deploy role) may do with the key: administration only, no wildcard. */
export const KEY_ADMIN_ACTIONS = Object.freeze([
  "kms:CreateAlias",
  "kms:DeleteAlias",
  "kms:UpdateAlias",
  "kms:DescribeKey",
  "kms:GetKeyPolicy",
  "kms:GetKeyRotationStatus",
  "kms:ListAliases",
  "kms:ListGrants",
  "kms:ListKeyPolicies",
  "kms:ListResourceTags",
  "kms:PutKeyPolicy",
  "kms:UpdateKeyDescription",
  "kms:EnableKey",
  "kms:DisableKey",
  "kms:EnableKeyRotation",
  "kms:DisableKeyRotation",
  "kms:TagResource",
  "kms:UntagResource",
  "kms:RevokeGrant",
  "kms:ScheduleKeyDeletion",
  "kms:CancelKeyDeletion",
] as const);

const ACCOUNT_ID = /^[0-9]{12}$/;

export interface KeyPolicy {
  readonly Version: "2012-10-17";
  readonly Statement: readonly {
    readonly Sid: string;
    readonly Effect: "Allow";
    readonly Principal: { readonly AWS: string };
    readonly Action: string | readonly string[];
    readonly Resource: "*";
    readonly Condition?: Record<string, Record<string, string>>;
  }[];
}

export function domainContactKeyPolicy(accountId: string, stage: string): KeyPolicy {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("domainContactKeyPolicy: account id is invalid");
  const root = `arn:aws:iam::${accountId}:root`;
  const role = (fn: string) => `arn:aws:iam::${accountId}:role/${roleName(stage, fn)}`;
  const bound = (fn: string) => ({
    ArnEquals: { "aws:PrincipalArn": role(fn) },
    StringEquals: { "kms:EncryptionContext:tc:purpose": DOMAIN_CONTACT_PURPOSE },
  });
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "KeyAdministration",
        Effect: "Allow",
        Principal: { AWS: root },
        Action: [...KEY_ADMIN_ACTIONS],
        Resource: "*",
      },
      {
        Sid: "WebEncryptsContacts",
        Effect: "Allow",
        Principal: { AWS: root },
        Action: ["kms:Encrypt"],
        Resource: "*",
        Condition: bound("web"),
      },
      {
        Sid: "ProvisionerDecryptsContacts",
        Effect: "Allow",
        Principal: { AWS: root },
        Action: ["kms:Decrypt"],
        Resource: "*",
        Condition: bound("provisioner"),
      },
    ],
  };
}
