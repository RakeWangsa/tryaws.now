// WP0-T2: the two Next.js apps behind CloudFront and WAF (3.2, 3.3).
//
// - protection: "oac-with-edge-signing" (documented values: none, oac, oac-with-edge-signing): the
//   function URL accepts only requests signed for the app's own distribution, so a direct request to
//   the function URL gets 403 and no request can skip the WAF or the admin allowlist.
// - R1: the web and admin roles have NO sts:AssumeRole permission. A static test reads this file
//   and fails if "sts:" appears in a permission list below.
// - The web function links only its own nine secrets and the web_rw password. It is never linked to
//   the Postgres component (the master user).
// - HSTS comes from the CloudFront response headers policy (waf.ts), not from application code.
//
// NOT TYPE-CHECKED, see network.ts.
import { DB_PASSWORD_SECRET, WEB_SECRETS } from "../lib/functions";
import { roleName, type StageConfig } from "../lib/stage";
import type { Auth } from "./auth";
import type { Database } from "./database";
import type { Messaging } from "./messaging";
import type { Network } from "./network";
import type { Secrets } from "./secrets";
import type { Storage } from "./storage";
import type { Waf } from "./waf";
import type { Workers } from "./workers";

export interface WebInputs {
  readonly config: StageConfig;
  readonly net: Network;
  readonly db: Database;
  readonly secrets: Secrets;
  readonly queues: Messaging;
  readonly storage: Storage;
  readonly auth: Auth;
  readonly waf: Waf;
  readonly workers: Workers;
}

// A fixed role name for the Next.js server function, and the edge function's role is SST's own.
// VERIFY: transform.server of sst.aws.Nextjs is FunctionArgs, so its own transform.role can set the name.
function fixedServerRole(name: string) {
  return (args: { transform?: { role?: unknown } }) => {
    args.transform = {
      ...(args.transform ?? {}),
      role: (role: { name?: string }) => {
        role.name = name;
      },
    };
  };
}

// WAF and the response headers policy are attached through transform.cdn (3.3: `webAclArn`).
// VERIFY: that setting defaultCacheBehavior.responseHeadersPolicyId inside transform.distribution
// keeps the behaviour that SST built for the origin.
function cdnTransform(aclArn: unknown, headersPolicyId: unknown) {
  return (args: { webAclArn?: unknown; transform?: Record<string, unknown> }) => {
    args.webAclArn = aclArn;
    args.transform = {
      ...(args.transform ?? {}),
      distribution: (distribution: {
        defaultCacheBehavior?: unknown;
        orderedCacheBehaviors?: unknown;
      }) => {
        const withPolicy = (behavior: Record<string, unknown>) => ({
          ...behavior,
          responseHeadersPolicyId: headersPolicyId,
        });
        distribution.defaultCacheBehavior = $output(distribution.defaultCacheBehavior).apply(
          (behavior) => withPolicy(behavior as Record<string, unknown>),
        );
        distribution.orderedCacheBehaviors = $output(distribution.orderedCacheBehaviors).apply(
          (behaviors) =>
            ((behaviors as Record<string, unknown>[] | undefined) ?? []).map(withPolicy),
        );
      },
    };
  };
}

export function web(inputs: WebInputs) {
  const { config, net, db, secrets, queues, storage, auth, waf, workers } = inputs;
  const stage = config.stage;
  const vpc = { privateSubnets: net.vpc.privateSubnets, securityGroups: [net.appSecurityGroup.id] };
  const invoke = (...dirs: string[]) => dirs.map((dir) => workers.invoked[dir]?.arn);
  const dbEnvironment = (role: string) => ({
    DB_HOST: db.connection.host,
    DB_PORT: db.connection.port,
    DB_NAME: db.connection.name,
    DB_USER: role,
    DB_SSLMODE: "verify-full",
  });

  const customer = new sst.aws.Nextjs("Web", {
    path: "apps/web",
    protection: "oac-with-edge-signing",
    vpc,
    domain: config.webDomain,
    // Nine secrets of apps/web/server/secrets.ts and the web_rw password. Not the Postgres component.
    link: [...WEB_SECRETS.map((name) => secrets.app[name]), secrets.db.web_rw],
    environment: {
      TC_STAGE: config.tcStage,
      APP_ORIGIN: `https://${config.webDomain}`,
      ...dbEnvironment("web_rw"),
      COGNITO_USER_POOL_ID: auth.customers.id,
      COGNITO_CLIENT_ID: auth.customerClient.id,
      PROVISIONING_QUEUE_URL: queues.provisioning.url,
      KYC_BUCKET: storage.kyc.name,
      INVOICES_BUCKET: storage.invoices.name,
      EXPORTS_BUCKET: storage.exports.name,
    },
    // Least privilege of web (3.2): enqueue, presign KYC uploads (PutObject only), read its own
    // invoices and exports, invoke reader, access-details and invoice-renderer, sign out its own
    // pool's users. No sts:AssumeRole, no kms:Decrypt on the kyc key, no s3:GetObject on kyc.
    permissions: [
      { actions: ["sqs:SendMessage"], resources: [queues.provisioning.arn] },
      {
        actions: ["lambda:InvokeFunction"],
        resources: invoke("reader", "access-details", "invoice-renderer"),
      },
      {
        actions: ["s3:PutObject"],
        resources: [$interpolate`${storage.kyc.arn}/*`],
      },
      { actions: ["kms:GenerateDataKey"], resources: [storage.kycKey.arn] },
      {
        actions: ["s3:GetObject"],
        resources: [
          $interpolate`${storage.invoices.arn}/*`,
          $interpolate`${storage.exports.arn}/*`,
        ],
      },
      { actions: ["kms:Decrypt"], resources: [storage.filesKey.arn] },
      { actions: ["cognito-idp:AdminUserGlobalSignOut"], resources: [auth.customers.arn] },
    ],
    transform: {
      server: fixedServerRole(roleName(stage, "web")),
      cdn: cdnTransform(waf.customerAclArn, waf.securityHeadersPolicyId),
    },
  });

  const admin = new sst.aws.Nextjs("Admin", {
    path: "apps/admin",
    protection: "oac-with-edge-signing",
    vpc,
    domain: config.adminDomain,
    // The admin app links no EPS secret. Its database role is admin_rw.
    link: [secrets.db.admin_rw],
    environment: {
      TC_STAGE: config.tcStage,
      APP_ORIGIN: `https://${config.adminDomain}`,
      // In-app second gate next to the WAF (apps/admin/server/gate.ts).
      ADMIN_IP_ALLOWLIST: config.adminAllowlist,
      ...dbEnvironment("admin_rw"),
      COGNITO_USER_POOL_ID: auth.admins.id,
      COGNITO_CLIENT_ID: auth.adminClient.id,
      PROVISIONING_QUEUE_URL: queues.provisioning.url,
      KYC_BUCKET: storage.kyc.name,
      INVOICES_BUCKET: storage.invoices.name,
      EXPORTS_BUCKET: storage.exports.name,
    },
    // Admin reads KYC objects (the only role that may), invokes catalog-sync, calls the Cognito admin
    // API of the admin pool only. No sts:AssumeRole.
    permissions: [
      { actions: ["sqs:SendMessage"], resources: [queues.provisioning.arn] },
      {
        actions: ["lambda:InvokeFunction"],
        resources: invoke("reader", "invoice-renderer", "catalog-sync"),
      },
      { actions: ["s3:GetObject"], resources: [$interpolate`${storage.kyc.arn}/*`] },
      { actions: ["kms:Decrypt"], resources: [storage.kycKey.arn] },
      {
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          $interpolate`${storage.invoices.arn}/*`,
          $interpolate`${storage.exports.arn}/*`,
        ],
      },
      { actions: ["kms:Decrypt", "kms:GenerateDataKey"], resources: [storage.filesKey.arn] },
      // Exactly what apps/admin/server/admin-directory.ts needs: invite (AdminCreateUser), describe
      // (ListUsers by sub, AdminGetUser), setEnabled (AdminEnableUser, AdminDisableUser) and resetMfa
      // (AdminSetUserMFAPreference, named need: the TOTP reset of the /admins screen). Not granted:
      // AdminSetUserPassword, AdminResetUserPassword, AdminUserGlobalSignOut (AdminDisableUser
      // revokes the user's tokens) and AdminUpdateUserAttributes. A new need is a reviewed change.
      {
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:ListUsers",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminSetUserMFAPreference",
        ],
        resources: [auth.admins.arn],
      },
    ],
    transform: {
      server: fixedServerRole(roleName(stage, "admin")),
      cdn: cdnTransform(waf.adminAclArn, waf.securityHeadersPolicyId),
    },
  });

  return { customer, admin, dbPasswordSecretNames: DB_PASSWORD_SECRET };
}

export type Web = ReturnType<typeof web>;
