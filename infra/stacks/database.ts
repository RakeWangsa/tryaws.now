// WP0-T3: RDS PostgreSQL with RDS Proxy (3.3, R2).
//
// sst.aws.Postgres defaults differ from the spec (rds.force_ssl 0, 7-day backups, final snapshot
// skipped, no deletion protection, the VPC default security group, proxy without requireTls), so each
// is overridden through `transform`. The instance sits in the private subnets, is never publicly
// accessible, and admits 5432 only from the proxy (network.ts). The database component is NOT
// linked to web, admin or workers: its link carries the master user (3.3). Only the migrator, which
// creates the roles, links it (workers.ts).
//
// NOT TYPE-CHECKED, see network.ts.
import { withForcedTls } from "../lib/database";
import { DB_PASSWORD_SECRET, PROXY_ROLES } from "../lib/functions";
import { backupRetentionDays, sizing } from "../lib/lean";
import { removalRules, resourceName, type StageConfig } from "../lib/stage";
import type { Network } from "./network";
import type { Secrets } from "./secrets";

export function database(config: StageConfig, net: Network, secrets: Secrets) {
  const stage = config.stage;
  // WPU-B8: instance, Multi-AZ and storage come from the stage size. Proxy, TLS and KMS are the same
  // in both sizes and on every stage (R2).
  const size = sizing(config.size, config.kind).database;
  // WPU-Z10 (owner decision 2026-11-13): staging is removed after each test session and its test data
  // is wiped, so it keeps one day of backups, has no deletion protection and skips the final snapshot
  // (`sst remove` must delete the instance). Production and personal stages keep deletion protection,
  // the final snapshot and the backup days of their size exactly as before (infra/lib/stage.ts
  // removalRules, infra/lib/lean.ts backupRetentionDays).
  const rules = removalRules(config.kind);

  const key = new aws.kms.Key("DatabaseKey", {
    description: `tc ${stage} database storage`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
  });

  const postgres = new sst.aws.Postgres("Database", {
    vpc: net.vpc,
    version: "17",
    instance: size.instance,
    // 3.3: Multi-AZ in production
    multiAz: size.multiAz,
    // lib/lean.ts types it as a string; both sizes hold "20 GB" (SizeGbTb, components/size.ts).
    storage: size.storage as `${number} GB`,
    // 3.3: list web_rw, admin_rw, worker_rw and report_ro; the component does not create these users.
    // The migrator function creates every role (workers.ts), with the passwords of the sst.Secret
    // values below. No password is written in code.
    proxy: {
      credentials: PROXY_ROLES.map((role) => ({
        username: role,
        password: secrets.db[role].value,
      })),
    },
    // Transform<rds.*Args>, as SST passes them (.sst/platform/src/components/aws/postgres.ts).
    transform: {
      instance: (args: aws.rds.InstanceArgs) => {
        // R2: private only. 3.3: 14 days (7 in lean, 1 on staging), deletion protection and a final
        // snapshot (not on staging, WPU-Z10), KMS storage encryption, and the instance's own security
        // group (never the VPC default group).
        args.publiclyAccessible = false;
        args.deletionProtection = rules.databaseDeletionProtection;
        args.backupRetentionPeriod = backupRetentionDays(config.kind, config.size);
        args.storageEncrypted = true;
        args.kmsKeyId = key.arn;
        args.skipFinalSnapshot = !rules.databaseFinalSnapshot;
        if (rules.databaseFinalSnapshot) {
          args.finalSnapshotIdentifier = resourceName(stage, "database-final");
        }
        args.copyTagsToSnapshot = true;
        args.vpcSecurityGroupIds = [net.databaseSecurityGroup.id];
        // VERIFY: that these aws.rds.Instance argument names match Pulumi AWS v7 and that the
        // component's own values (set before this callback runs) are overwritten, not merged.
        // Automated backups go with a deleted instance (deleteAutomatedBackups defaults to true), so a
        // removal of staging leaves no backup storage behind.
      },
      parameterGroup: (args: aws.rds.ParameterGroupArgs) => {
        // TLS forced for the instance by exactly ONE rds.force_ssl = 1, which REPLACES the 0 that SST
        // sets (infra/lib/database.ts withForcedTls; VERIFY review 2026-11-13, B1 database.ts:63).
        args.parameters = $output(args.parameters).apply((existing) =>
          withForcedTls(existing ?? []),
        );
      },
      proxy: (args: aws.rds.ProxyArgs) => {
        // TLS forced for the proxy: requireTls true. Own security group (proxy -> database only).
        args.requireTls = true;
        args.vpcSecurityGroupIds = [net.proxySecurityGroup.id];
        args.debugLogging = false;
      },
    },
  });

  return {
    postgres,
    // Non-secret connection facts for the functions. The password comes from the linked secret of
    // the function's own role (DB_PASSWORD_SECRET), never from here.
    // `host` is the proxy endpoint when `proxy` is on (WPU-Z9: SST 4.17.2 postgres.ts `get host`
    // returns proxy?.endpoint, else the instance endpoint). `as`: under noUncheckedIndexedAccess
    // SST infers Output<string | undefined> there (endpoint.split(":")[0]); it is always a string.
    connection: {
      host: postgres.host as $util.Output<string>,
      port: postgres.port,
      name: postgres.database,
    },
    passwordSecretNames: DB_PASSWORD_SECRET,
  };
}

export type Database = ReturnType<typeof database>;
