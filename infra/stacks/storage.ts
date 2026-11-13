// WP0-T4: buckets kyc, invoices, exports (3.3). All private, Block Public Access on, SSE-KMS.
// The kyc bucket denies GetObject for the web role: the proof that WP2-T4 depends on ("read only by
// admin"). WPU-Y3: the web tier learns whether an upload arrived from the kyc-check function, whose own
// role may HEAD kyc/* (workers.ts) and has no grant on the kyc key; the deny below stays as it is. The deny is written twice, on purpose: in the bucket policy and by giving the web role no
// kms:Decrypt on the kyc key.
//
// WPU-Z10: a removal of staging empties and deletes the three buckets (forceDestroy set here; staging test
// data is wiped by decision). Production and personal stages get the bucket arguments exactly as before
// (SST's own forceDestroy default; production's `retain` keeps its buckets on a removal anyway).
//
// NOT TYPE-CHECKED, see network.ts.
import { removalRules, resourceName, roleName, type StageConfig } from "../lib/stage";

const BLOCK_ALL = {
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
};

function privateBucket(
  name: string,
  key: aws.kms.Key,
  forceEmpty: boolean,
  extraPolicy: sst.aws.BucketArgs["policy"] = [],
) {
  const bucket = new sst.aws.Bucket(name, {
    // access is not set: the default grants no public access. versioning keeps overwritten KYC files.
    versioning: true,
    enforceHttps: true,
    policy: extraPolicy,
    transform: {
      // Transform<s3.BucketArgs> (components/aws/bucket.ts createBucket). Staging only (removalRules
      // forceEmptyBuckets): forceDestroy deletes every object and every version, then the bucket.
      ...(forceEmpty
        ? {
            bucket: (args: aws.s3.BucketArgs) => {
              args.forceDestroy = true;
            },
          }
        : {}),
      // VERIFY: transform.publicAccessBlock is listed in the docs; the docs do not say whether the
      // component creates one by default, so it is set here explicitly.
      // Transform<s3.BucketPublicAccessBlockArgs>, as SST passes it (components/aws/bucket.ts).
      publicAccessBlock: (args: aws.s3.BucketPublicAccessBlockArgs) => {
        Object.assign(args, BLOCK_ALL);
      },
    },
  });
  // Default encryption with the KMS key. VERIFY: Pulumi AWS v7 name of this resource
  // (BucketServerSideEncryptionConfiguration, formerly ...ConfigurationV2) and its bucket argument.
  new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: bucket.name,
    rules: [
      {
        applyServerSideEncryptionByDefault: {
          sseAlgorithm: "aws:kms",
          kmsMasterKeyId: key.arn,
        },
        bucketKeyEnabled: true,
      },
    ],
  });
  return bucket;
}

export function storage(config: StageConfig) {
  const stage = config.stage;
  const account = config.accountId;

  const kycKey = new aws.kms.Key("KycKey", {
    description: `tc ${stage} kyc bucket`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
  });
  new aws.kms.Alias("KycKeyAlias", {
    name: `alias/${resourceName(stage, "kyc")}`,
    targetKeyId: kycKey.keyId,
  });
  const filesKey = new aws.kms.Key("FilesKey", {
    description: `tc ${stage} invoices and exports buckets`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
  });
  new aws.kms.Alias("FilesKeyAlias", {
    name: `alias/${resourceName(stage, "files")}`,
    targetKeyId: filesKey.keyId,
  });

  // The web function role has a fixed name (workers.ts / web.ts set it with transform), so the
  // policy can name it without creating a dependency on the function.
  // VERIFY: effect "deny", principals and conditions shapes of sst.aws.Bucket `policy` (the docs list
  // actions, conditions, effect, paths, principals); the aws:PrincipalArn condition below is what
  // keeps this a Deny for the web role only.
  const webRoleArn = `arn:aws:iam::${account}:role/${roleName(stage, "web")}`;
  // `as const`: the Bucket policy takes the literals "deny" and "*" (components/aws/bucket.ts).
  const denyWebRead = {
    effect: "deny" as const,
    principals: "*" as const,
    actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"],
    paths: ["*"],
    conditions: [{ test: "ArnEquals", variable: "aws:PrincipalArn", values: [webRoleArn] }],
  };

  const { forceEmptyBuckets } = removalRules(config.kind);
  const kyc = privateBucket("Kyc", kycKey, forceEmptyBuckets, [denyWebRead]);
  const invoices = privateBucket("Invoices", filesKey, forceEmptyBuckets);
  const exportFiles = privateBucket("Exports", filesKey, forceEmptyBuckets);

  // Lifecycle: exports are temporary files for customers.
  // VERIFY: aws.s3.BucketLifecycleConfiguration; keep 30 days is a placeholder (Needs decision).
  new aws.s3.BucketLifecycleConfiguration("ExportsLifecycle", {
    bucket: exportFiles.name,
    rules: [{ id: "expire-exports", status: "Enabled", filter: {}, expiration: { days: 30 } }],
  });

  return { kyc, invoices, exports: exportFiles, kycKey, filesKey };
}

export type Storage = ReturnType<typeof storage>;
