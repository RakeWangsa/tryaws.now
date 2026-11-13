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
import { DB_PASSWORD_SECRET, PROXY_ROLES } from "../lib/functions";
import { sizing } from "../lib/lean";
import { resourceName, type StageConfig } from "../lib/stage";
import type { Network } from "./network";
import type { Secrets } from "./secrets";

export function database(config: StageConfig, net: Network, secrets: Secrets) {
  const stage = config.stage;
  // WPU-B8: instance, Multi-AZ, storage and backup days come from the stage size. Proxy, TLS, KMS,
  // deletion protection and the final snapshot are the same in both sizes (R2, R13).
  const size = sizing(config.size, config.kind).database;

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
        // R2: private only. 3.3: 14 days (7 in lean), deletion protection, KMS storage encryption, a final
        // snapshot, and the instance's own security group (never the VPC default group).
        args.publiclyAccessible = false;
        args.deletionProtection = true;
        args.backupRetentionPeriod = size.backupRetentionDays;
        args.storageEncrypted = true;
        args.kmsKeyId = key.arn;
        args.skipFinalSnapshot = false;
        args.finalSnapshotIdentifier = resourceName(stage, "database-final");
        args.copyTagsToSnapshot = true;
        args.vpcSecurityGroupIds = [net.databaseSecurityGroup.id];
        // VERIFY: that these aws.rds.Instance argument names match Pulumi AWS v7 and that the
        // component's own values (set before this callback runs) are overwritten, not merged.
      },
      parameterGroup: (args: aws.rds.ParameterGroupArgs) => {
        // TLS forced for the instance: rds.force_ssl = 1.
        // VERIFY: rds.force_ssl is a dynamic parameter (applyMethod immediate) for the chosen
        // parameter group family, and the component's default parameters keep their shape.
        args.parameters = $output(args.parameters).apply((existing) => [
          ...(existing ?? []),
          { name: "rds.force_ssl", value: "1", applyMethod: "immediate" },
        ]);
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
