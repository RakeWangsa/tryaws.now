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
import { resourceName, type StageConfig } from "../lib/stage";
import type { Network } from "./network";
import type { Secrets } from "./secrets";

export function database(config: StageConfig, net: Network, secrets: Secrets) {
  const stage = config.stage;
  const production = config.kind === "production";

  const key = new aws.kms.Key("DatabaseKey", {
    description: `tc ${stage} database storage`,
    enableKeyRotation: true,
    deletionWindowInDays: 30,
  });

  const postgres = new sst.aws.Postgres("Database", {
    vpc: net.vpc,
    version: "17",
    instance: production ? "t4g.medium" : "t4g.micro",
    // 3.3: Multi-AZ in production
    multiAz: production,
    storage: "20 GB",
    // 3.3: list web_rw, admin_rw, worker_rw and report_ro; the component does not create these users.
    // The migrator function creates every role (workers.ts), with the passwords of the sst.Secret
    // values below. No password is written in code.
    proxy: {
      credentials: PROXY_ROLES.map((role) => ({
        username: role,
        password: secrets.db[role].value,
      })),
    },
    transform: {
      instance: (args: Record<string, unknown>) => {
        // R2: private only. 3.3: 14 days, deletion protection, KMS storage encryption, a final
        // snapshot, and the instance's own security group (never the VPC default group).
        args.publiclyAccessible = false;
        args.deletionProtection = true;
        args.backupRetentionPeriod = 14;
        args.storageEncrypted = true;
        args.kmsKeyId = key.arn;
        args.skipFinalSnapshot = false;
        args.finalSnapshotIdentifier = resourceName(stage, "database-final");
        args.copyTagsToSnapshot = true;
        args.vpcSecurityGroupIds = [net.databaseSecurityGroup.id];
        // VERIFY: that these aws.rds.Instance argument names match Pulumi AWS v7 and that the
        // component's own values (set before this callback runs) are overwritten, not merged.
      },
      parameterGroup: (args: { parameters?: unknown }) => {
        // TLS forced for the instance: rds.force_ssl = 1.
        // VERIFY: rds.force_ssl is a dynamic parameter (applyMethod immediate) for the chosen
        // parameter group family, and the component's default parameters keep their shape.
        args.parameters = $output(args.parameters).apply((existing: unknown) => [
          ...((existing as unknown[] | undefined) ?? []),
          { name: "rds.force_ssl", value: "1", applyMethod: "immediate" },
        ]);
      },
      proxy: (args: Record<string, unknown>) => {
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
    // VERIFY: that `host` is the proxy endpoint when `proxy` is on (the docs show host, port,
    // database, username, password, but not which endpoint host names).
    connection: {
      host: postgres.host,
      port: postgres.port,
      name: postgres.database,
    },
    passwordSecretNames: DB_PASSWORD_SECRET,
  };
}

export type Database = ReturnType<typeof database>;
