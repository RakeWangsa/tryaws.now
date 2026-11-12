// WP0-T3/T4: the Lambda functions of functions/ (3.2), each with the least privilege its row allows.
//
// - Only provisioner, reader, access-details, catalog-sync and reconciler may assume roles in pool or
//   DNS accounts (infra/lib/functions.ts, POOL_ROLE_FUNCTIONS). The role ARNs are built from the
//   environment of the deploy (assumableRoleArns); no account id is written in the repository.
// - Each function links only the secrets it uses, and only the database password of its own role.
//   Only the migrator links the Postgres component (the master user) and all five role passwords.
// - Role names are fixed (roleName), so the trust policies of the pool accounts can name them with an
//   aws:PrincipalArn condition (6.3).
//
// NOT TYPE-CHECKED, see network.ts.
import { PROVISIONING_QUEUE } from "../../packages/core/operations/queue-config";
import { DB_PASSWORD_SECRET, DB_ROLES, FUNCTIONS, type FunctionSpec } from "../lib/functions";
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
  const permissions: { actions: string[]; resources: unknown[] }[] = [];
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
  if (spec.dir === "invoice-renderer") {
    permissions.push(
      { actions: ["s3:PutObject"], resources: [$interpolate`${storage.invoices.arn}/*`] },
      { actions: ["kms:GenerateDataKey"], resources: [storage.filesKey.arn] },
    );
  }
  return permissions;
}

function environmentOf(spec: FunctionSpec, inputs: WorkerInputs): Record<string, unknown> {
  const { config, db, queues } = inputs;
  const env: Record<string, unknown> = {
    TC_STAGE: config.tcStage,
    TC_ENV: config.tcStage,
  };
  if (spec.dbRole !== "none") {
    // R2: through the proxy, TLS only. The password comes from the linked secret of this role.
    // packages/db builds the URL at run time (databaseUrlFromEnv): the parts here, the password from
    // the linked secret that DB_PASSWORD_SECRET names (SST_RESOURCE_<name>). The migrator reads the
    // master user from the linked Postgres resource and ignores DB_USER and DB_PASSWORD_SECRET.
    env.DB_HOST = db.connection.host;
    env.DB_PORT = db.connection.port;
    env.DB_NAME = db.connection.name;
    env.DB_USER = spec.dbRole;
    env.DB_PASSWORD_SECRET = DB_PASSWORD_SECRET[spec.dbRole];
    env.DB_SSLMODE = "verify-full";
  }
  if (spec.dir === "provisioner" || spec.dir === "scheduler") {
    env.PROVISIONING_QUEUE_URL = queues.provisioning.url;
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
  }
  if (spec.dir === "payments-sweeper") {
    env.EPS_MODE = config.tcStage === "production" ? "production" : "sandbox";
    env.PUBLIC_BASE_URL = `https://${config.webDomain}`;
  }
  if (spec.dir === "catalog-sync") {
    env.CATALOG_POOL_ACCOUNT_ID = config.poolAccountIds[0];
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
    // Alone among the functions: the master user (to create the roles) and the five passwords.
    links.push(db.postgres, ...DB_ROLES.map((role) => secrets.db[role]));
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

export function functionArgs(spec: FunctionSpec, inputs: WorkerInputs) {
  return {
    handler: `functions/${spec.dir}/index.${spec.handlerExport}`,
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
      // Only the reader publishes versions: its tier aliases need a numbered version (WPU-S6).
      ...(spec.dir === "reader"
        ? {
            function: (args: { publish?: boolean }) => {
              args.publish = true;
            },
          }
        : {}),
      role: (args: { name?: string }) => {
        // VERIFY: the docs do not say that transform.role may set the IAM role name; the Pulumi
        // aws.iam.Role `name` argument is what is set here.
        args.name = roleName(inputs.config.stage, spec.dir);
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
  queues.provisioning.subscribe(functionArgs(provisionerSpec, inputs), {
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
  // VERIFY: `transform.function` reaches the aws.lambda.Function of sst.aws.Function (publish makes a
  // numbered version; an alias cannot point to $LATEST) and `nodes.function.version` is that version.
  const reader = invoked["reader"] as {
    nodes: { function: { version: unknown } };
    name: unknown;
  };
  const readerAliases = Object.fromEntries(
    (["web", "admin"] as const).map((tier) => [
      tier,
      new aws.lambda.Alias(`ReaderAlias${tier === "web" ? "Web" : "Admin"}`, {
        name: tier,
        functionName: reader.name as string,
        functionVersion: reader.nodes.function.version as string,
      }),
    ]),
  ) as Record<"web" | "admin", { arn: unknown }>;

  // Scheduled: EventBridge Scheduler (sst.aws.CronV2), retry policy 0 (the functions are idempotent
  // and the next run repeats the work). VERIFY: CronV2 args `schedule`, `function`, `retries`.
  const crons = Object.fromEntries(
    FUNCTIONS.filter((f) => f.trigger.kind === "cron").map((f) => {
      const trigger = f.trigger as { schedule: string };
      return [
        f.dir,
        new sst.aws.CronV2(f.component, {
          schedule: trigger.schedule,
          function: functionArgs(f, inputs),
          retries: 0,
        }),
      ];
    }),
  );

  // Deploy time: the migrator creates the roles and runs the migrations with the master user.
  // VERIFY: aws.lambda.Invocation re-runs when `triggers` change; a changing value runs it on every
  // deploy, which is safe because migrations are forward-only and idempotent (R15).
  const migrator = new sst.aws.Function("Migrator", functionArgs(specOf("migrator"), inputs));
  const migration = new aws.lambda.Invocation("MigratorRun", {
    functionName: migrator.name,
    input: JSON.stringify({ action: "migrate" }),
    triggers: { run: String(Date.now()) },
  });

  return { invoked, readerAliases, crons, migrator, migration };
}

export type Workers = ReturnType<typeof workers>;
