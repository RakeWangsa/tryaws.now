// WPU-X10: the KMS key of the domain registrant contact. Read from the source text of infra/stacks like
// infra-rules.test.mjs (comments removed first, so a comment cannot satisfy or break a rule). Pinned: only the web
// role may Encrypt with the key, only the provisioner may Decrypt, the web role has no sts:AssumeRole (R1), and the
// seal and the unseal bind the same encryption context.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOMAIN_CONTACT_PURPOSE,
  KEY_ADMIN_ACTIONS,
  domainContactKeyPolicy,
} from "../../infra/lib/kms.ts";

const root = resolve(import.meta.dirname, "../..");

function source(file) {
  const text = readFileSync(resolve(root, file), "utf8");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .replace(/,\s*([\]})])/g, "$1");
}

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = endMarker === undefined ? text.length : text.indexOf(endMarker, start + 1);
  return text.slice(start, end === -1 ? text.length : end);
}

const storage = source("infra/stacks/storage.ts");
const web = source("infra/stacks/web.ts");
const workers = source("infra/stacks/workers.ts");
const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');
const admin = between(web, 'new sst.aws.Nextjs("Admin"');

describe("WPU-X10: the domain-contact key", () => {
  it("is one rotating key with the alias tc-<stage>-domain-contact, returned by storage()", () => {
    expect(storage).toContain('new aws.kms.Key("DomainContactKey", {');
    const key = between(storage, 'new aws.kms.Key("DomainContactKey"', "});");
    expect(key).toContain("enableKeyRotation: true");
    expect(key).toContain("deletionWindowInDays: 30");
    expect(storage).toContain(
      'new aws.kms.Alias("DomainContactKeyAlias", { name: `alias/${resourceName(stage, "domain-contact")}`, targetKeyId: domainContactKey.keyId',
    );
    expect(storage).toMatch(/return \{[^}]*domainContactKey \}/);
  });

  it("only the web role may Encrypt with it, and only kms:Encrypt", () => {
    const grants = [
      ...web.matchAll(/\{ actions: \[([^\]]*)\], resources: \[storage\.domainContactKey\.arn\]/g),
    ];
    expect(grants.map((m) => m[1])).toEqual(['"kms:Encrypt"']);
    expect(customer).toContain(
      '{ actions: ["kms:Encrypt"], resources: [storage.domainContactKey.arn],',
    );
    expect(customer).toContain("DOMAIN_CONTACT_KEY_ARN: storage.domainContactKey.arn");
    expect(admin).not.toContain("domainContactKey");
    expect(admin).not.toContain("DOMAIN_CONTACT_KEY_ARN");
  });

  it("only the provisioner may Decrypt with it, and only kms:Decrypt", () => {
    const grants = [
      ...workers.matchAll(
        /\{ actions: \[([^\]]*)\], resources: \[storage\.domainContactKey\.arn\]/g,
      ),
    ];
    expect(grants.map((m) => m[1])).toEqual(['"kms:Decrypt"']);
    const branch = between(
      workers,
      'if (spec.dir === "provisioner") { permissions.push(',
      "} if (",
    );
    expect(branch).toContain(
      '{ actions: ["kms:Decrypt"], resources: [storage.domainContactKey.arn],',
    );
    expect(workers).toContain("env.TC_DOMAIN_CONTACT_KEY_ARN = storage.domainContactKey.arn;");
    // the variable is set inside the provisioner branch of environmentOf and nowhere else
    expect(workers.match(/TC_DOMAIN_CONTACT_KEY_ARN/g)).toHaveLength(1);
    const envBranch = between(
      workers,
      'if (spec.dir === "provisioner") { Object.assign(env, provisionerNetworkEnvironment(config));',
      "} if (",
    );
    expect(envBranch).toContain("TC_DOMAIN_CONTACT_KEY_ARN");
    // the key is referenced nowhere else in the stacks
    expect(storage.match(/domainContactKey\b/g)).toHaveLength(3);
    expect(web.match(/domainContactKey/g)).toHaveLength(2);
    expect(workers.match(/domainContactKey/g)).toHaveLength(2);
  });

  it("the web and admin roles keep no sts:AssumeRole (R1)", () => {
    expect(web).not.toContain("sts:AssumeRole");
    expect(web).not.toMatch(/"sts:\*"|"kms:\*"/);
  });

  it("the seal and the unseal bind the same encryption context and never import across R1", () => {
    const seal = source("apps/web/server/domain-seal.ts");
    const unseal = source("packages/aws/contact-unseal.ts");
    const context = '"tc:purpose": "domain-contact"';
    expect(seal).toContain(context);
    expect(unseal).toContain(context);
    // the web seal imports only EncryptCommand and KMSClient, and nothing of packages/aws (R1)
    expect(seal).toContain('import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";');
    expect(seal).not.toMatch(/DecryptCommand|GenerateDataKey|@tc\/aws|packages\/aws/);
    expect(seal).toContain("new EncryptCommand(");
    // the provisioner unseal decrypts only
    expect(unseal).toContain('import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";');
    expect(unseal).toContain("new DecryptCommand(");
    expect(unseal).not.toMatch(/new EncryptCommand|GenerateDataKey/);
  });
});

// WPU-X10 review fix 1 and 2: the key policy of the domain-contact key. The default policy (account root, kms:*)
// would let any principal with kms:* in IAM (the CI deploy roles, an admin) decrypt contacts. The explicit policy
// gives the account (and through IAM the deploy role of the stage) the administration of the key only, Encrypt to
// the web role only and Decrypt to the provisioner role only, both bound to the encryption context.
describe("WPU-X10 review: the policy of the domain-contact key", () => {
  const ACCOUNT = "123456789012";
  const policy = domainContactKeyPolicy(ACCOUNT, "staging");
  const root = `arn:aws:iam::${ACCOUNT}:root`;
  const list = (v) => (Array.isArray(v) ? v : [v]);
  const CRYPTO =
    /^kms:(Encrypt|Decrypt|ReEncrypt|GenerateDataKey|GenerateMac|VerifyMac|Sign|Verify|CreateGrant|\*)/;

  it("storage.ts sets the policy on the key", () => {
    const key = between(storage, 'new aws.kms.Key("DomainContactKey"', "});");
    expect(key).toContain("policy: JSON.stringify(domainContactKeyPolicy(account, stage))");
  });

  it("the account gets the administration of the key only, never a cryptographic action or a grant", () => {
    const admin = policy.Statement.filter((s) => s.Sid === "KeyAdministration");
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ Effect: "Allow", Principal: { AWS: root }, Resource: "*" });
    expect(admin[0].Condition).toBeUndefined();
    expect(list(admin[0].Action)).toEqual([...KEY_ADMIN_ACTIONS]);
    for (const action of KEY_ADMIN_ACTIONS) {
      expect(action).not.toMatch(CRYPTO);
      expect(action).not.toContain("*");
    }
    // what Pulumi needs to read, change, rotate, tag and delete the key and its alias
    for (const needed of [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:EnableKeyRotation",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
    ]) {
      expect(KEY_ADMIN_ACTIONS).toContain(needed);
    }
  });

  it("no statement allows a cryptographic action without the role and the context condition", () => {
    const crypto = policy.Statement.filter((s) => list(s.Action).some((a) => CRYPTO.test(a)));
    expect(crypto.map((s) => [s.Sid, list(s.Action)])).toEqual([
      ["WebEncryptsContacts", ["kms:Encrypt"]],
      ["ProvisionerDecryptsContacts", ["kms:Decrypt"]],
    ]);
    const [webStatement, provisionerStatement] = crypto;
    for (const s of crypto) {
      expect(s.Effect).toBe("Allow");
      expect(s.Principal).toEqual({ AWS: root });
      expect(s.Condition.StringEquals).toEqual({
        "kms:EncryptionContext:tc:purpose": DOMAIN_CONTACT_PURPOSE,
      });
    }
    expect(webStatement.Condition.ArnEquals).toEqual({
      "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/tc-staging-web-role`,
    });
    expect(provisionerStatement.Condition.ArnEquals).toEqual({
      "aws:PrincipalArn": `arn:aws:iam::${ACCOUNT}:role/tc-staging-provisioner-role`,
    });
    expect(DOMAIN_CONTACT_PURPOSE).toBe("domain-contact");
    expect(policy.Statement).toHaveLength(3);
    expect(policy.Statement.every((s) => s.Effect === "Allow")).toBe(true);
  });

  it("follows the stage in the role names (personal stages too, no CI role named)", () => {
    const personal = JSON.stringify(domainContactKeyPolicy(ACCOUNT, "dev-moshi"));
    expect(personal).toContain("role/tc-dev-moshi-web-role");
    expect(personal).toContain("role/tc-dev-moshi-provisioner-role");
    expect(personal).not.toMatch(/TcCi/);
    expect(() => domainContactKeyPolicy("nope", "staging")).toThrow();
  });

  it("the IAM grants carry the same context condition (review fix 2)", () => {
    const cond =
      'conditions: [{ test: "StringEquals", variable: "kms:EncryptionContext:tc:purpose", values: [DOMAIN_CONTACT_PURPOSE] }]';
    // brackets and braces without the spaces around them, in the source and in the expectation
    const tight = (text) => text.replace(/\s*([[\]{}])\s*/g, "$1");
    expect(tight(customer)).toContain(
      tight(`{ actions: ["kms:Encrypt"], resources: [storage.domainContactKey.arn], ${cond} }`),
    );
    expect(tight(workers)).toContain(
      tight(`{ actions: ["kms:Decrypt"], resources: [storage.domainContactKey.arn], ${cond} }`),
    );
    // the stack output of the web role policies keeps the condition
    expect(web).toContain("Condition: $output(p.conditions).apply((list) =>");
  });
});
