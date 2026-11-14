// WP0-T2: the two Next.js apps behind CloudFront and WAF (3.2, 3.3).
//
// - protection: "oac-with-edge-signing" (documented values: none, oac, oac-with-edge-signing): the
//   function URL accepts only requests signed for the app's own distribution, so a direct request to
//   the function URL gets 403 and no request can skip the WAF or the admin allowlist.
// - R1: the web and admin roles have NO sts:AssumeRole permission. A static test reads this file
//   and fails if "sts:" appears in a permission list below.
// - The web function links only its own eleven secrets and the web_rw password. It is never linked to
//   the Postgres component (the master user).
// - HSTS comes from the CloudFront response headers policy (waf.ts), not from application code.
//
// NOT TYPE-CHECKED, see network.ts.
import { ADMIN_SECRETS, DB_PASSWORD_SECRET, WEB_SECRETS } from "../lib/functions";
import { DOMAIN_CONTACT_PURPOSE } from "../lib/kms";
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

// The callback form of SST's Transform<T> (.sst/platform/src/components/component.ts): it changes
// the arguments in place and returns undefined. A callback built away from its call site needs it.
type TransformFn<T> = (args: T) => undefined;

// A fixed role name for the Next.js server function, and the edge function's role is SST's own.
// VERIFY: transform.server of sst.aws.Nextjs is FunctionArgs, so its own transform.role can set the name.
function fixedServerRole(name: string): TransformFn<sst.aws.FunctionArgs> {
  return (args) => {
    args.transform = {
      ...(args.transform ?? {}),
      role: (role) => {
        role.name = name;
      },
    };
  };
}

// WAF and the response headers policy are attached through transform.cdn (3.3: `webAclArn`).
// VERIFY: that setting defaultCacheBehavior.responseHeadersPolicyId inside transform.distribution
// keeps the behaviour that SST built for the origin.
function cdnTransform(
  aclArn: $util.Input<string>,
  headersPolicyId: $util.Input<string>,
): TransformFn<sst.aws.CdnArgs> {
  return (args) => {
    args.webAclArn = aclArn;
    args.transform = {
      ...(args.transform ?? {}),
      distribution: (distribution) => {
        const withPolicy = <T extends object>(behavior: T) => ({
          ...behavior,
          responseHeadersPolicyId: headersPolicyId,
        });
        distribution.defaultCacheBehavior = $output(distribution.defaultCacheBehavior).apply(
          (behavior) => withPolicy(behavior),
        );
        distribution.orderedCacheBehaviors = $output(distribution.orderedCacheBehaviors).apply(
          (behaviors) => (behaviors ?? []).map(withPolicy),
        );
      },
    };
  };
}

// The IAM form of the `conditions` of a FunctionPermissionArgs: { test: { variable: values } }. NOT TYPE-CHECKED.
function conditionOf(conditions: unknown) {
  return $output(conditions).apply((list) =>
    Object.fromEntries(
      (list as { test: string; variable: string; values: string[] }[]).map((c) => [
        c.test,
        { [c.variable]: c.values },
      ]),
    ),
  );
}

export function web(inputs: WebInputs) {
  const { config, net, db, secrets, queues, storage, auth, waf, workers } = inputs;
  const stage = config.stage;
  const vpc = { privateSubnets: net.vpc.privateSubnets, securityGroups: [net.appSecurityGroup.id] };
  // C.2: the permission lists of the web and admin roles, kept as IAM policy documents for the stack
  // output `webRolePolicies` that scripts/post-deploy-check.mjs reads (R1: none allows sts:AssumeRole).
  // They are built from the same lists the Nextjs components receive, so they cannot drift apart.
  const recorded: sst.aws.FunctionPermissionArgs[][] = [];
  const record = (permissions: sst.aws.FunctionPermissionArgs[]) => {
    recorded.push(permissions);
    return permissions;
  };
  // The function of a folder that the web tier calls by name (workers.invoked). WPU-Z9, fail closed
  // (R16): a folder without a function stops the deploy here, never an undefined name later.
  const functionOf = (dir: string) => {
    const fn = workers.invoked[dir];
    if (fn === undefined) throw new Error(`no function for ${dir}`);
    return fn;
  };
  // WPU-S6: each tier may invoke only its own alias of the reader (customerId on "web", adminId on
  // "admin"); the handler reads the tier from the alias in the invoked ARN.
  const dbEnvironment = (role: "web_rw" | "admin_rw") => ({
    DB_HOST: db.connection.host,
    // WPU-Z9: the port is a number output; a Lambda environment value must be a string
    // (FunctionArgs.environment, components/aws/function.ts).
    DB_PORT: $interpolate`${db.connection.port}`,
    DB_NAME: db.connection.name,
    DB_USER: role,
    // The name of the linked secret that holds this role's password (packages/db/env.ts).
    DB_PASSWORD_SECRET: DB_PASSWORD_SECRET[role],
    DB_SSLMODE: "verify-full",
  });

  const customer = new sst.aws.Nextjs("Web", {
    path: "apps/web",
    protection: "oac-with-edge-signing",
    vpc,
    domain: config.webDomain,
    // Eleven secrets of apps/web/server/secrets.ts (WPU-Z3: with the two of the SMS gateway) and the
    // web_rw password. Not the Postgres component.
    link: [...WEB_SECRETS.map((name) => secrets.app[name]), secrets.db.web_rw],
    environment: {
      TC_STAGE: config.tcStage,
      APP_ORIGIN: `https://${config.webDomain}`,
      ...dbEnvironment("web_rw"),
      // The names packages/auth/config.ts authConfigFromEnv reads (the old COGNITO_USER_POOL_ID and
      // COGNITO_CLIENT_ID were read by nothing: the first deploy would have had no sign-in).
      COGNITO_CUSTOMER_POOL_ID: auth.customers.id,
      COGNITO_CUSTOMER_CLIENT_ID: auth.customerClient.id,
      PROVISIONING_QUEUE_URL: queues.provisioning.url,
      // WPU-G4: the function name (not the ARN) of the reader, for the Metrics tab. The role may
      // invoke it (permissions below); apps/web/server/reader-invoke.ts builds the client lazily.
      READER_FUNCTION_NAME: functionOf("reader").name,
      // WPU-N2: the function name of access-details (one-time secrets). The client invokes the "web"
      // alias only (apps/web/server/access-invoke.ts) and the role may invoke that alias only.
      ACCESS_DETAILS_FUNCTION_NAME: functionOf("access-details").name,
      // WPU-N1: the function name of the invoice renderer, for "Download PDF"
      // (apps/web/server/renderer-invoke.ts); the role may invoke its "web" alias only.
      INVOICE_RENDERER_FUNCTION_NAME: functionOf("invoice-renderer").name,
      // WPU-Y3: the function name of kyc-check, which answers whether a KYC upload arrived
      // (apps/web/server/kyc-check-invoke.ts); the role may invoke its "web" alias only. The web role
      // itself keeps no read of the kyc bucket (storage.ts denies it).
      KYC_CHECK_FUNCTION_NAME: functionOf("kyc-check").name,
      // WPU-X10: the key that seals the registrant contact of a domain draft (apps/web/server/domain-seal.ts).
      DOMAIN_CONTACT_KEY_ARN: storage.domainContactKey.arn,
      // Final review M5: no KYC_BUCKET or EXPORTS_BUCKET: no code of apps/, packages/ or functions/ reads them.
      // The grants below stay for the code that will use the buckets; that code adds its variable with it.
    },
    // Least privilege of web (3.2): enqueue, presign KYC uploads (PutObject only), read its own
    // invoices and exports, invoke reader, access-details, invoice-renderer and kyc-check, sign out
    // its own pool's users. No sts:AssumeRole, no kms:Decrypt on the kyc key, no s3:GetObject on kyc.
    permissions: record([
      { actions: ["sqs:SendMessage"], resources: [queues.provisioning.arn] },
      {
        actions: ["lambda:InvokeFunction"],
        // WPU-N1: the renderer only through its "web" alias (the role may not invoke the bare function).
        // WPU-N2: access-details likewise (customerId is accepted only on its "web" alias).
        resources: [
          workers.readerAliases.web.arn,
          workers.rendererAliasWeb.arn,
          workers.accessAliases.web.arn,
          // WPU-Y3: kyc-check likewise (customerId is accepted only on its "web" alias).
          workers.kycCheckAliases.web.arn,
        ],
      },
      {
        actions: ["s3:PutObject"],
        resources: [$interpolate`${storage.kyc.arn}/*`],
      },
      { actions: ["kms:GenerateDataKey"], resources: [storage.kycKey.arn] },
      {
        actions: ["s3:GetObject"],
        // WPU-B7 (L2): exports/* only. The invoice PDF reaches the customer in the answer of the renderer
        // (pdfBase64, WPU-N1); nothing in the web tier reads the invoices bucket.
        resources: [$interpolate`${storage.exports.arn}/*`],
      },
      { actions: ["kms:Decrypt"], resources: [storage.filesKey.arn] },
      // WPU-X10: seal only (kms:Encrypt) with the domain-contact key; the provisioner alone may Decrypt (R1).
      // Review fix 2: only for the encryption context of the seal (the key policy asks the same, infra/lib/kms.ts).
      {
        actions: ["kms:Encrypt"],
        resources: [storage.domainContactKey.arn],
        conditions: [
          {
            test: "StringEquals",
            variable: "kms:EncryptionContext:tc:purpose",
            values: [DOMAIN_CONTACT_PURPOSE],
          },
        ],
      },
      { actions: ["cognito-idp:AdminUserGlobalSignOut"], resources: [auth.customers.arn] },
    ]),
    transform: {
      server: fixedServerRole(roleName(stage, "web")),
      // WPU-Z11 (VERIFY of 2026-11-13, B2): SST names the ISR revalidation subscriber role from a long
      // logical name that loses the tryaws-now-<stage>- prefix, which the CI deploy policy refuses.
      revalidationEventsSubscriber: fixedServerRole(roleName(stage, "web-revalidation")),
      cdn: cdnTransform(waf.customerAclArn, waf.securityHeadersPolicyId),
    },
  });

  const admin = new sst.aws.Nextjs("Admin", {
    path: "apps/admin",
    protection: "oac-with-edge-signing",
    vpc,
    domain: config.adminDomain,
    // The admin app links no EPS secret. Its database role is admin_rw. WPU-X1: AdminIpLimitKey is the
    // HMAC key of the sign-in rate-limit subject (apps/admin/server/rate-subject.ts).
    link: [...ADMIN_SECRETS.map((name) => secrets.app[name]), secrets.db.admin_rw],
    environment: {
      TC_STAGE: config.tcStage,
      APP_ORIGIN: `https://${config.adminDomain}`,
      // In-app second gate next to the WAF (apps/admin/server/gate.ts).
      ADMIN_IP_ALLOWLIST: config.adminAllowlist,
      ...dbEnvironment("admin_rw"),
      // The names packages/auth/config.ts adminAuthConfigFromEnv reads.
      COGNITO_ADMIN_POOL_ID: auth.admins.id,
      COGNITO_ADMIN_CLIENT_ID: auth.adminClient.id,
      // Final review M5: no KYC_BUCKET or EXPORTS_BUCKET (nothing reads them; see the web app above).
    },
    // Admin reads KYC objects (the only role that may) and calls the Cognito admin API of the admin
    // pool only. No sts:AssumeRole. No grant on the invoices bucket and no invoke of
    // invoice-renderer (WPU-S8): an invoice PDF holds the buyer's BIN or NID and address; the renderer
    // function writes it and the customer's own web path reads it.
    // WPU-B7 (L1): no sqs:SendMessage and no queue URL: the admin app has no queue client, it writes
    // operation rows and the scheduler enqueues them (R1).
    // WPU-Z9 (least privilege): no invoke of catalog-sync, which 3.2 allows: nothing in apps/admin
    // calls it (its daily CronV2 runs it). An admin "sync now" adds the grant with its invoker.
    permissions: record([
      {
        actions: ["lambda:InvokeFunction"],
        resources: [workers.readerAliases.admin.arn],
      },
      { actions: ["s3:GetObject"], resources: [$interpolate`${storage.kyc.arn}/*`] },
      { actions: ["kms:Decrypt"], resources: [storage.kycKey.arn] },
      {
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [$interpolate`${storage.exports.arn}/*`],
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
    ]),
    transform: {
      server: fixedServerRole(roleName(stage, "admin")),
      // WPU-Z11 (VERIFY of 2026-11-13, B2): SST names the ISR revalidation subscriber role from a long
      // logical name that loses the tryaws-now-<stage>- prefix, which the CI deploy policy refuses.
      revalidationEventsSubscriber: fixedServerRole(roleName(stage, "admin-revalidation")),
      cdn: cdnTransform(waf.adminAclArn, waf.securityHeadersPolicyId),
    },
  });

  // VERIFY: $jsonStringify exists in the SST global scope and resolves Output values inside the object.
  const webRolePolicies = recorded.map((permissions) =>
    $jsonStringify({
      Version: "2012-10-17",
      Statement: permissions.map((p) => ({
        Effect: "Allow",
        Action: p.actions,
        Resource: p.resources,
        // WPU-X10 review: a grant with conditions (the domain-contact key) keeps them in the output.
        ...(p.conditions === undefined ? {} : { Condition: conditionOf(p.conditions) }),
      })),
    }),
  );

  return { customer, admin, webRolePolicies, dbPasswordSecretNames: DB_PASSWORD_SECRET };
}

export type Web = ReturnType<typeof web>;
