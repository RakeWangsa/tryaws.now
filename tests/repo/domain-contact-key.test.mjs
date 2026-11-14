// WPU-X10: the KMS key of the domain registrant contact. Read from the source text of infra/stacks like
// infra-rules.test.mjs (comments removed first, so a comment cannot satisfy or break a rule). Pinned: only the web
// role may Encrypt with the key, only the provisioner may Decrypt, the web role has no sts:AssumeRole (R1), and the
// seal and the unseal bind the same encryption context.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
      ...web.matchAll(
        /\{ actions: \[([^\]]*)\], resources: \[storage\.domainContactKey\.arn\] \}/g,
      ),
    ];
    expect(grants.map((m) => m[1])).toEqual(['"kms:Encrypt"']);
    expect(customer).toContain(
      '{ actions: ["kms:Encrypt"], resources: [storage.domainContactKey.arn] }',
    );
    expect(customer).toContain("DOMAIN_CONTACT_KEY_ARN: storage.domainContactKey.arn");
    expect(admin).not.toContain("domainContactKey");
    expect(admin).not.toContain("DOMAIN_CONTACT_KEY_ARN");
  });

  it("only the provisioner may Decrypt with it, and only kms:Decrypt", () => {
    const grants = [
      ...workers.matchAll(
        /\{ actions: \[([^\]]*)\], resources: \[storage\.domainContactKey\.arn\] \}/g,
      ),
    ];
    expect(grants.map((m) => m[1])).toEqual(['"kms:Decrypt"']);
    const branch = between(
      workers,
      'if (spec.dir === "provisioner") { permissions.push(',
      "} if (",
    );
    expect(branch).toContain(
      '{ actions: ["kms:Decrypt"], resources: [storage.domainContactKey.arn] }',
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
    expect(storage.match(/domainContactKey/g)).toHaveLength(3);
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
