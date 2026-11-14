// WP0-T3/T4: the Lambda functions of functions/ (3.2), each with the least privilege its row allows.
//
// - Only provisioner, reader, access-details, catalog-sync and reconciler may assume roles in pool or
//   DNS accounts (infra/lib/functions.ts, POOL_ROLE_FUNCTIONS). The role ARNs are built from the
//   environment of the deploy (assumableRoleArns); no account id is written in the repository.
// - Each function links only the secrets it uses, and only the database password of its own role.
//   Only the migrator links the Postgres component (the master user), all five role passwords and the
//   optional FirstAdminSub (WPU-Z18).
// - Role names are fixed (roleName), so the trust policies of the pool accounts can name them with an
//   aws:PrincipalArn condition (6.3).
//
// NOT TYPE-CHECKED, see network.ts.
import { PROVISIONING_QUEUE } from "../../packages/core/operations/queue-config";
import {
  DB_PASSWORD_SECRET,
  DB_ROLES,
  FUNCTIONS,
  LEDGER_CHECK_FUNCTION,
  LEDGER_CHECK_SCHEDULE,
  provisionerNetworkEnvironment,
  type FunctionSpec,
} from "../lib/functions";
import { workerLogRetention } from "../lib/lean";
import { DOMAIN_CONTACT_PURPOSE } from "../lib/kms";
import { assumableRoleArns, roleName, type StageConfig } from "../lib/stage";
import type { Database } from "./database";
import type { Messaging } from "./messaging";
import type { Network } from "./network";
import type { Secrets } from "./secrets";
import type { Storage } from "./storage";

export interface WorkerInputs {
  readonly config: StageConfig;
  readonly net: Network;
  readonly db: Database;
  readonly secrets: Secrets;
  readonly queues: Messaging;
  readonly storage: Storage;
}

function permissionsOf(spec: FunctionSpec, inputs: WorkerInputs) {
  const { config, queues, storage } = inputs;
  const permissions: sst.aws.FunctionPermissionArgs[] = [];
  const roles = [...new Set(spec.poolRoles)];
  if (roles.length > 0) {
    permissions.push({
      actions: ["sts:AssumeRole"],
      resources: roles.flatMap((role) => assumableRoleArns(role, config)),
    });
  }
  if (spec.dir === "provisioner" || spec.dir === "scheduler") {
    permissions.push({ actions: ["sqs:SendMessage"], resources: [queues.provisioning.arn] });
  }
  if (spec.dir === "notifier") {
    permissions.push({ actions: ["ses:SendEmail"], resources: [config.sesIdentityArn] });
  }
  if (spec.dir === "kyc-check") {
    // WPU-Y3. HeadObject has no IAM action of its own: "To use HEAD, you must have the s3:GetObject
    // permission" (S3 API reference, HeadObject). So s3:GetObject on kyc/* and on nothing else, and NO
    // kms:Decrypt on the kyc key. The kyc bucket policy denies every upload that is not SSE-KMS with the
    // kyc key (storage.ts, kycEncryptionOnly), so a GetObject of the content by this role is refused and
    // only the metadata of a HEAD comes back. s3:ListBucket on the bucket, without a prefix condition
    // (every object lives under kyc/, and the implicit ListBucket check that S3 makes for a HEAD has no
    // documented s3:prefix, so a condition could turn a missing key into 403), so that a missing key
    // answers 404 and not 403 (same page).
    // VERIFY (staging): a HEAD of a missing key answers 404 ("upload missing"); a HEAD of an upload
    // answers without kms:Decrypt; a GetObject by this role is denied.
    permissions.push(
      { actions: ["s3:GetObject"], resources: [$interpolate`${storage.kyc.arn}/kyc/*`] },
      { actions: ["s3:ListBucket"], resources: [storage.kyc.arn] },
    );
  }
  if (spec.dir === "provisioner") {
    // WPU-X10: opens the sealed registrant contact of a domain order (packages/aws/contact-unseal.ts). Decrypt
    // only, on this key only; the web role seals (kms:Encrypt, web.ts) and no other role has a grant.
    // Review fix 2: only for the encryption context of the seal (the key policy asks the same, infra/lib/kms.ts).
    permissions.push({
      actions: ["kms:Decrypt"],
      resources: [storage.domainContactKey.arn],
      conditions: [
        {
          test: "StringEquals",
          variable: "kms:EncryptionContext:tc:purpose",
          values: [DOMAIN_CONTACT_PURPOSE],
        },
      ],
    });
  }
  if (spec.dir === "invoice-renderer") {
    permissions.push(
      { actions: ["s3:PutObject"], resources: [$interpolate`${storage.invoices.arn}/*`] },
      { actions: ["kms:GenerateDataKey"], resources: [storage.filesKey.arn] },
    );
  }
  return permissions;
}

// Lambda environment values are strings (FunctionArgs.environment, components/aws/function.ts).
function environmentOf(
  spec: FunctionSpec,
  inputs: WorkerInputs,
): Record<string, $util.Input<string>> {
  const { config, db, queues, storage } = inputs;
  const env: Record<string, $util.Input<string>> = {
    TC_STAGE: config.tcStage,
    TC_ENV: config.tcStage,
  };
  if (spec.dbRole !== "none") {
    // R2: through the proxy, TLS only. The password comes from the linked secret of this role.
    // packages/db builds the URL at run time (databaseUrlFromEnv): the parts here, the password from
    // the linked secret that DB_PASSWORD_SECRET names (SST_RESOURCE_<name>). The migrator reads the
    // master user from the linked Postgres resource and ignores DB_USER and DB_PASSWORD_SECRET.
    env.DB_HOST = db.connection.host;
    // WPU-Z9: the port is a number output; an environment value is a string (environmentOf).
    env.DB_PORT = $interpolate`${db.connection.port}`;
    env.DB_NAME = db.connection.name;
    env.DB_USER = spec.dbRole;
    env.DB_PASSWORD_SECRET = DB_PASSWORD_SECRET[spec.dbRole];
    env.DB_SSLMODE = "verify-full";
  }
  if (spec.dir === "provisioner" || spec.dir === "scheduler") {
    env.PROVISIONING_QUEUE_URL = queues.provisioning.url;
  }
  if (spec.dir === "invoice-renderer") {
    // The one bucket the renderer writes to (PutObject on invoices/* only, permissionsOf).
    env.INVOICES_BUCKET = storage.invoices.name;
  }
  if (spec.dir === "kyc-check") {
    // WPU-Y3: the one bucket kyc-check asks (functions/kyc-check/config.ts reads KYC_BUCKET).
    env.KYC_BUCKET = storage.kyc.name;
  }
  if (spec.dir === "provisioner") {
    // C.5: required stack configuration on staging and production (infra/lib/stage.ts).
    Object.assign(env, provisionerNetworkEnvironment(config));
    // WPU-D4: the tc-dns account of the Route 53 client; plain values (6.3), the same as catalog-sync.
    env.TC_DNS_ACCOUNT_ID = config.dnsAccountId;
    env.TC_DNS_EXTERNAL_ID = config.dnsExternalId;
    // WPU-X10: the key ARN of the registrant contact (functions/provisioner/domain.ts domainPortsFromEnv).
    env.TC_DOMAIN_CONTACT_KEY_ARN = storage.domainContactKey.arn;
  }
  if (spec.dir === "notifier") {
    // Links in a message go only to the panel's own domain (16.14); the sender is the verified identity.
    env.PANEL_ORIGIN = `https://${config.webDomain}`;
    env.SES_FROM = config.sesFromAddress;
    // WPU-D4: the same identity ARN that the IAM statement allows; no configuration set is defined yet.
    env.SES_IDENTITY_ARN = config.sesIdentityArn;
  }
  if (spec.dir === "migrator") {
    // copyFiles (functionArgs) puts packages/db/migrations here, next to the bundle.
    env.MIGRATIONS_DIR = "/var/task/migrations";
    // WPU-X4: the pool account bootstrap (functions/migrator, step pool_account). The id list as the
    // deploy has it (several ids: the migrator does nothing) and, only when set, the plain ExternalId of
    // the tc-pool-roles stack (6.3). No other function gets TC_POOL_EXTERNAL_ID.
    env.TC_POOL_ACCOUNT_IDS = config.poolAccountIds.join(",");
    if (config.poolExternalId !== null) env.TC_POOL_EXTERNAL_ID = config.poolExternalId;
  }
  if (spec.dir === "payments-sweeper") {
    env.EPS_MODE = config.tcStage === "production" ? "production" : "sandbox";
    env.PUBLIC_BASE_URL = `https://${config.webDomain}`;
  }
  if (spec.dir === "catalog-sync") {
    // `!`: readStageConfig refuses an empty TC_POOL_ACCOUNT_IDS (infra/lib/stage.ts).
    env.CATALOG_POOL_ACCOUNT_ID = config.poolAccountIds[0]!;
    env.CATALOG_REGIONS = "ap-southeast-1";
    env.CATALOG_DNS_ACCOUNT_ID = config.dnsAccountId;
    env.CATALOG_DNS_EXTERNAL_ID = config.dnsExternalId;
  }
  return env;
}

function linksOf(spec: FunctionSpec, inputs: WorkerInputs): unknown[] {
  const { secrets, db } = inputs;
  const links: unknown[] = spec.secrets.map((name) => secrets.app[name]);
  if (spec.dbRole === "worker_rw") links.push(secrets.db.worker_rw);
  if (spec.dbRole === "migrator") {
    // Alone among the functions: the master user (to create the roles) and the five passwords, and
    // (WPU-Z18) the optional FirstAdminSub of the first-superadmin bootstrap.
    links.push(db.postgres, ...DB_ROLES.map((role) => secrets.db[role]), secrets.firstAdminSub);
  }
  return links;
}

function vpcOf(spec: FunctionSpec, net: Network) {
  if (spec.placement === "app") {
    return { privateSubnets: net.vpc.privateSubnets, securityGroups: [net.appSecurityGroup.id] };
  }
  if (spec.placement === "isolated") {
    return {
      privateSubnets: net.isolatedSubnetIds,
      securityGroups: [net.isolatedSecurityGroup.id],
    };
  }
  return undefined;
}

// invoice-renderer (WPU-D1, 3.2): headless Chromium on x86_64, in the isolated subnets (network.ts) with
// no route to the internet. @sparticuz/chromium and puppeteer-core stay OUTSIDE the bundle (nodejs.install):
// the Chromium binary is read from the package's bin folder, which a bundler would move. The Bengali
// fonts are copied to /var/task/fonts, a folder that the fonts.conf of @sparticuz/chromium lists. The
// browser unpacks itself to /tmp, so the function gets 2 GB of /tmp.
// VERIFY (staging): nodejs.install installs the two packages with the versions of
// functions/invoice-renderer/package.json; copyFiles puts the folder at /var/task/fonts.
function rendererArgs(spec: FunctionSpec): Partial<sst.aws.FunctionArgs> {
  if (spec.dir !== "invoice-renderer") return {};
  return {
    architecture: "x86_64",
    storage: "2 GB",
    nodejs: { install: ["@sparticuz/chromium", "puppeteer-core"] },
    copyFiles: [{ from: "functions/invoice-renderer/fonts", to: "fonts" }],
  };
}

// The functions whose aliases (below) point at a published, numbered version.
const PUBLISHED_VERSIONS: readonly string[] = [
  "reader",
  "access-details",
  "invoice-renderer",
  "kyc-check",
];

// Typed as sst.aws.Function takes it; without that, `timeout` and `memory` widen to string.
export function functionArgs(spec: FunctionSpec, inputs: WorkerInputs): sst.aws.FunctionArgs {
  return {
    ...rendererArgs(spec),
    handler: `functions/${spec.dir}/index.${spec.handlerExport}`,
    // WPU-B8: log groups expire (7 days lean, 14 full). WPU-Z10: one week on staging whatever the size
    // (workerLogRetention); the functions that SST components build get theirs from infra/stacks/logs.ts.
    // VERIFY result (WPU-Z9, SST 4.17.2 components/aws/logging.ts RETENTION): "1 week" is 7 days and
    // "2 weeks" 14 days.
    logging: { retention: workerLogRetention(inputs.config.kind, inputs.config.size) },
    timeout: `${spec.timeoutSeconds} seconds`,
    memory: `${spec.memoryMb} MB`,
    // VERIFY: `copyFiles` of sst.aws.Function copies the folder into the deployment package; the
    // migrator reads the SQL files at run time (they are not bundled).
    ...(spec.dir === "migrator"
      ? { copyFiles: [{ from: "packages/db/migrations", to: "migrations" }] }
      : {}),
    vpc: vpcOf(spec, inputs.net),
    link: linksOf(spec, inputs),
    permissions: permissionsOf(spec, inputs),
    environment: environmentOf(spec, inputs),
    transform: {
      // The four functions with aliases publish versions (reader WPU-S6, invoice renderer WPU-B7 L3,
      // access-details WPU-N2, kyc-check WPU-Y3): publishing pins each alias to an immutable numbered
      // version per deploy.
      // WPU-Z10, VERIFY review 2026-11-13 (docs/analysis/verify-review-2026-11-13.md, B1
      // infra/stacks/workers.ts:230 and :250, lines 156 to 177): an alias CAN point to $LATEST (only a
      // weighted alias cannot), and access-details did not publish, so its alias pointed at $LATEST.
      // Transform<lambda.FunctionArgs> and Transform<iam.RoleArgs>, as SST passes them.
      ...(PUBLISHED_VERSIONS.includes(spec.dir)
        ? {
            function: (args: aws.lambda.FunctionArgs) => {
              args.publish = true;
            },
          }
        : {}),
      role: (args: aws.iam.RoleArgs) => {
        // VERIFY: the docs do not say that transform.role may set the IAM role name; the Pulumi
        // aws.iam.Role `name` argument is what is set here.
        args.name = roleName(inputs.config.stage, spec.name ?? spec.dir);
      },
    },
  };
}

function specOf(dir: string): FunctionSpec {
  const spec = FUNCTIONS.find((f) => f.dir === dir);
  if (spec === undefined) throw new Error(`no function spec for ${dir}`);
  return spec;
}

export function workers(inputs: WorkerInputs) {
  const { queues } = inputs;

  // provisioner: SQS FIFO, one message per invocation, partial batch responses (queue-config.ts).
  // VERIFY: queue.subscribe takes function args here and applies `batch` to the event source mapping.
  const provisionerSpec = specOf("provisioner");
  // WPU-B3: kept, so that the alarms can name its log group and its error metric.
  const provisioner = queues.provisioning.subscribe(functionArgs(provisionerSpec, inputs), {
    batch: {
      size: PROVISIONING_QUEUE.batchSize,
      partialResponses: PROVISIONING_QUEUE.reportBatchItemFailures,
    },
  });

  // Invoked by web and admin: plain functions, no URL (no function URL at all).
  const invoked = Object.fromEntries(
    FUNCTIONS.filter((f) => f.trigger.kind === "invoke").map((f) => [
      f.dir,
      new sst.aws.Function(f.component, functionArgs(f, inputs)),
    ]),
  );

  // WPU-S6: the reader has one alias per tier. The handler takes the tier from the alias in the invoked
  // ARN (functions/reader/invoke.ts) and accepts customerId only on "web" and adminId only on "admin";
  // web.ts grants each role lambda:InvokeFunction on its own alias ARN and on no other.
  // VERIFY result (verify review 2026-11-13, B1 workers.ts:230): `transform.function` reaches the
  // aws.lambda.Function of sst.aws.Function, publish makes a numbered version, and
  // `nodes.function.version` is that version; each alias is pinned to it (PUBLISHED_VERSIONS).
  // `as`: FUNCTIONS holds an invoke row for reader, access-details, invoice-renderer and kyc-check
  // (infra/lib/functions.ts); without one, the property reads below stop the deploy.
  const reader = invoked["reader"] as sst.aws.Function;
  // `as`: Object.fromEntries forgets the two keys of the tuple it is built from.
  const readerAliases = Object.fromEntries(
    (["web", "admin"] as const).map((tier) => [
      tier,
      new aws.lambda.Alias(`ReaderAlias${tier === "web" ? "Web" : "Admin"}`, {
        name: tier,
        functionName: reader.name,
        functionVersion: reader.nodes.function.version,
      }),
    ]),
  ) as Record<"web" | "admin", aws.lambda.Alias>;

  // WPU-N2: access-details has one alias, "web". The function accepts customerId only on it
  // (functions/access-details/invoke.ts) and web.ts grants the web role lambda:InvokeFunction on
  // this alias ARN and on nothing else, so the unaliased function cannot be invoked by web.
  // WPU-Z10: the same mechanics as the reader above (it publishes now, PUBLISHED_VERSIONS).
  const accessDetails = invoked["access-details"] as sst.aws.Function;
  const accessAliases = {
    web: new aws.lambda.Alias("AccessAliasWeb", {
      name: "web",
      functionName: accessDetails.name,
      functionVersion: accessDetails.nodes.function.version,
    }),
  };
  // WPU-N1: the invoice renderer has one alias, "web". The customer role may invoke that alias and no
  // other form of the function; the admin role has no grant on the renderer at all (WPU-S8).
  // VERIFY: same as the reader aliases above (the published version, `nodes.function.version`).
  const renderer = invoked["invoice-renderer"] as sst.aws.Function;
  const rendererAliasWeb = new aws.lambda.Alias("InvoiceRendererAliasWeb", {
    name: "web",
    functionName: renderer.name,
    functionVersion: renderer.nodes.function.version,
  });

  // WPU-Y3: kyc-check has one alias, "web", like access-details. The handler refuses every other qualifier
  // (functions/kyc-check/handler.ts) and web.ts grants the web role lambda:InvokeFunction on this alias
  // ARN only.
  const kycCheck = invoked["kyc-check"] as sst.aws.Function;
  const kycCheckAliases = {
    web: new aws.lambda.Alias("KycCheckAliasWeb", {
      name: "web",
      functionName: kycCheck.name,
      functionVersion: kycCheck.nodes.function.version,
    }),
  };

  // Scheduled: EventBridge Scheduler (sst.aws.CronV2), retry policy 0 (the functions are idempotent
  // and the next run repeats the work). VERIFY: CronV2 args `schedule`, `function`, `retries`.
  const crons = Object.fromEntries(
    FUNCTIONS.filter((f) => f.trigger.kind === "cron").map((f) => {
      const trigger = f.trigger as { schedule: string };
      return [
        f.dir,
        new sst.aws.CronV2(f.component, {
          // `as`: lib/functions.ts types it as a string; every row is rate(...) or cron(...).
          schedule: trigger.schedule as sst.aws.CronV2Args["schedule"],
          function: functionArgs(f, inputs),
          retries: 0,
        }),
      ];
    }),
  );

  // C.13: the daily ledger check at 02:00 Asia/Dhaka (20:00 UTC), next to the hourly reconciler.
  crons["ledger-check"] = new sst.aws.CronV2(LEDGER_CHECK_FUNCTION.component, {
    schedule: LEDGER_CHECK_SCHEDULE,
    function: functionArgs(LEDGER_CHECK_FUNCTION, inputs),
    retries: 0,
  });

  // Deploy time: the migrator creates the roles and runs the migrations with the master user.
  // VERIFY: aws.lambda.Invocation re-runs when `triggers` change; a changing value runs it on every
  // deploy, which is safe because migrations are forward-only and idempotent (R15).
  const migrator = new sst.aws.Function("Migrator", functionArgs(specOf("migrator"), inputs));
  const migration = new aws.lambda.Invocation("MigratorRun", {
    functionName: migrator.name,
    input: JSON.stringify({ action: "migrate" }),
    triggers: { run: String(Date.now()) },
  });

  return {
    invoked,
    readerAliases,
    accessAliases,
    rendererAliasWeb,
    crons,
    provisioner,
    migrator,
    migration,
    kycCheckAliases,
  };
}

export type Workers = ReturnType<typeof workers>;
