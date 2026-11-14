// WP0-T4: Cognito pools for customers and admins (6.1, 6.2). Both send e-mail through SES. The
// custom-message trigger (functions/cognito-messages) renders the e-mails; it reads no database and
// assumes no role (3.2), so it runs outside the VPC with no links.
//
// WPU-Z10 (requirement 3): `sst remove --stage staging` keeps both user pools, so the admin users and their
// TOTP survive between test sessions (a pool costs nothing without active users). Each pool is created
// with Pulumi `retainOnDelete` on staging: a removal drops it from the state and leaves it in AWS (its
// deletion protection would refuse a delete anyway). The next deploy adopts the kept pool with Pulumi
// `import` when its id is given (TC_COGNITO_CUSTOMER_POOL_ID, TC_COGNITO_ADMIN_POOL_ID, infra/lib/stage.ts
// readUserPoolIds; staging only), else it creates a new pool. An import succeeds only when the arguments
// match the kept pool, so on staging the trigger function has a fixed name: its ARN, which the pool
// stores (lambdaConfig.customMessage), is then the same in every session.
// VERIFY (first adoption, `sst diff --stage staging`): the two pools show "import" and no replacement,
// the admin users can sign in with their TOTP, and the stack outputs customerPoolId and adminPoolId equal
// the two variables. If the import refuses a difference, the runbook's fallback applies
// (docs/runbooks/staging-on-demand.md).
// Production and personal stages are unchanged: no retainOnDelete, no import, SST's own function name.
//
// NOT TYPE-CHECKED, see network.ts.
import { removalRules, resourceName, roleName, type StageConfig } from "../lib/stage";

// 6.1 password policy of at least 12 characters.
const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: false,
  temporaryPasswordValidityDays: 3,
};

export function auth(config: StageConfig) {
  const stage = config.stage;
  const { retainUserPools } = removalRules(config.kind);

  // The resource options of a kept and adopted pool (staging); nothing elsewhere.
  const keepPool = (opts: $util.CustomResourceOptions, poolId: string | null) => {
    if (!retainUserPools) return;
    opts.retainOnDelete = true;
    if (poolId !== null) opts.import = poolId;
  };

  const email = {
    // Cognito sends through the verified SES identity (not the default Cognito sender).
    emailSendingAccount: "DEVELOPER",
    sourceArn: config.sesIdentityArn,
    fromEmailAddress: config.sesFromAddress,
  };

  // The trigger function: one Lambda for both pools.
  const messages = new sst.aws.Function("CognitoMessages", {
    handler: "functions/cognito-messages/index.handler",
    // Staging: a fixed name, so the kept pools still point at the trigger of the next session (above).
    ...(retainUserPools ? { name: resourceName(stage, "cognito-messages") } : {}),
    // 3.2 sizes: a short function; the e-mail must stay under 20,000 characters.
    timeout: "5 seconds",
    memory: "256 MB",
    transform: {
      // Transform<iam.RoleArgs>, as SST passes it (.sst/platform/src/components/aws/function.ts).
      role: (args: aws.iam.RoleArgs) => {
        args.name = roleName(stage, "cognito-messages");
      },
    },
  });

  // Customers: e-mail and password sign-up, e-mail verification, optional TOTP.
  const customers = new sst.aws.CognitoUserPool("CustomerPool", {
    usernames: ["email"],
    mfa: "optional",
    softwareToken: true,
    triggers: { customMessage: messages.arn },
    transform: {
      // Transform<cognito.UserPoolArgs>, as SST passes it (components/aws/cognito-user-pool.ts).
      userPool: (args: aws.cognito.UserPoolArgs, opts) => {
        keepPool(opts, config.userPoolIds.customers);
        args.name = resourceName(stage, "customers");
        args.passwordPolicy = PASSWORD_POLICY;
        args.autoVerifiedAttributes = ["email"];
        // A changed e-mail stays unverified, and the old one stays valid, until the new address
        // proves itself. WPU-Z9: the field is attributesRequireVerificationBeforeUpdates, plural
        // (@pulumi/aws 7.20.0 types/input.d.ts, UserPoolUserAttributeUpdateSettings); the singular
        // name of before is not a Pulumi argument.
        args.userAttributeUpdateSettings = {
          attributesRequireVerificationBeforeUpdates: ["email"],
        };
        args.emailConfiguration = email;
        args.deletionProtection = "ACTIVE";
        args.accountRecoverySetting = {
          recoveryMechanisms: [{ name: "verified_email", priority: 1 }],
        };
        // Self sign-up stays on for customers (adminCreateUserConfig.allowAdminCreateUserOnly false).
        args.adminCreateUserConfig = { allowAdminCreateUserOnly: false };
      },
    },
  });
  const customerClient = customers.addClient("CustomerAppClient", {
    transform: {
      // Transform<cognito.UserPoolClientArgs> (components/aws/cognito-user-pool-client.ts).
      client: (args: aws.cognito.UserPoolClientArgs) => {
        // No client secret: the Next.js server uses the SRP or password flow of the SDK.
        // VERIFY: transform.client key of CognitoUserPool.addClient and the auth flows 6.1 needs.
        args.generateSecret = false;
        // The platform identifies users by `sub` (customers.cognito_sub), never by e-mail. The app
        // client may write only harmless profile attributes. E-mail and phone changes go through the
        // app's fresh sign-in and new verification (AccountPorts, apps/web/server/settings-actions.ts)
        // with the server's own credentials, so email, phone_number and every custom attribute are
        // left out. VERIFY: Pulumi aws.cognito.UserPoolClient writeAttributes.
        // WPU-X12: sign-up goes through CustomerSignUpClient below, so this client needs no email and
        // no locale. The profile locale lives in the database only (settings-actions.ts updateProfile
        // writes no Cognito attribute), so nothing writes locale through a customer token.
        args.writeAttributes = ["name"];
        args.explicitAuthFlows = [
          "ALLOW_USER_PASSWORD_AUTH",
          "ALLOW_REFRESH_TOKEN_AUTH",
          "ALLOW_USER_SRP_AUTH",
        ];
        args.preventUserExistenceErrors = "ENABLED";
      },
    },
  });

  // WPU-X12: the server-only sign-up client. Cognito refused every sign-up through CustomerAppClient
  // ("A client attempted to write unauthorized attribute", staging 2026-11-14): SignUp writes email,
  // name and locale. Widening CustomerAppClient instead (the staging-only commit 5c94ac41) would let any
  // holder of a customer access token call UpdateUserAttributes and VerifyUserAttribute on email
  // directly at Cognito, past the app's fresh sign-in, rate limit and audit: the e-mail is the login
  // name and the recovery channel, so a stolen token would become a persistent takeover. This client
  // has a secret, so only the web server function (the one place the secret is linked, web.ts) can use
  // it, and no sign-in flow, so it never issues the token that UpdateUserAttributes needs.
  // packages/auth/cognito-identity.ts sends SignUp, ConfirmSignUp and ResendConfirmationCode through it
  // with a SecretHash; everything else stays on CustomerAppClient.
  const customerSignUpClient = customers.addClient("CustomerSignUpClient", {
    transform: {
      client: (args: aws.cognito.UserPoolClientArgs) => {
        args.generateSecret = true;
        // SignUp writes exactly these three (packages/auth/cognito-identity.ts). No phone (our own OTP),
        // no custom attribute.
        args.writeAttributes = ["email", "name", "locale"];
        // VERIFY (first deploy): that Cognito accepts a read list equal to the write list. The client
        // issues no token, so the read list only has to cover what it writes.
        args.readAttributes = ["email", "name", "locale"];
        // No sign-in: without a list Cognito would allow refresh, SRP and custom auth
        // (CreateUserPoolClient, ExplicitAuthFlows), and an empty list may read as "no list". Refresh
        // alone signs no one in, and this client never hands out a refresh token.
        // VERIFY (first deploy): CreateUserPoolClient accepts ["ALLOW_REFRESH_TOKEN_AUTH"] alone.
        args.explicitAuthFlows = ["ALLOW_REFRESH_TOKEN_AUTH"];
        // No OAuth and no managed login: SST's client turns both on with a placeholder callback URL
        // (components/aws/cognito-user-pool-client.ts); this client is for the user pools API only.
        args.allowedOauthFlowsUserPoolClient = false;
        args.allowedOauthFlows = [];
        args.allowedOauthScopes = [];
        args.callbackUrls = [];
        // The shortest validity Cognito allows, should a token ever be issued.
        args.accessTokenValidity = 5;
        args.idTokenValidity = 5;
        args.refreshTokenValidity = 60;
        args.tokenValidityUnits = {
          accessToken: "minutes",
          idToken: "minutes",
          refreshToken: "minutes",
        };
        // ConfirmSignUp and ResendConfirmationCode answer the same for unknown addresses.
        args.preventUserExistenceErrors = "ENABLED";
      },
    },
  });

  // Admins: separate pool, no self sign-up, TOTP required (mfa "on" = mfaConfiguration ON), 8-hour sessions.
  const admins = new sst.aws.CognitoUserPool("AdminPool", {
    usernames: ["email"],
    mfa: "on",
    softwareToken: true,
    triggers: { customMessage: messages.arn },
    transform: {
      userPool: (args: aws.cognito.UserPoolArgs, opts) => {
        keepPool(opts, config.userPoolIds.admins);
        args.name = resourceName(stage, "admins");
        args.passwordPolicy = PASSWORD_POLICY;
        args.autoVerifiedAttributes = ["email"];
        args.userAttributeUpdateSettings = {
          attributesRequireVerificationBeforeUpdates: ["email"],
        };
        args.emailConfiguration = email;
        args.deletionProtection = "ACTIVE";
        // No self sign-up (6.2): only an administrator creates users.
        args.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
        // TOTP only: no SMS second factor.
        args.softwareTokenMfaConfiguration = { enabled: true };
      },
    },
  });
  const adminClient = admins.addClient("AdminAppClient", {
    transform: {
      client: (args: aws.cognito.UserPoolClientArgs) => {
        args.generateSecret = false;
        // No self-service attribute writes for admins: an empty allowlist. Admin users are created
        // and changed only through the admin API (IAM) of the admin pool.
        args.writeAttributes = [];
        // Short sessions: 8 hours (6.2). VERIFY: units; Cognito allows refresh 60 minutes to 10 years.
        args.refreshTokenValidity = 8;
        args.accessTokenValidity = 1;
        args.idTokenValidity = 1;
        args.tokenValidityUnits = { refreshToken: "hours", accessToken: "hours", idToken: "hours" };
        // WPU-Z15: exactly the flow of the admin sign-in (USER_PASSWORD_AUTH, then the
        // SOFTWARE_TOKEN_MFA challenge, packages/auth/admin-signin.ts), and refresh. Without a list
        // Cognito allows only refresh, SRP and custom auth, and the sign-in is refused.
        args.explicitAuthFlows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"];
        args.preventUserExistenceErrors = "ENABLED";
      },
    },
  });

  return { customers, customerClient, customerSignUpClient, admins, adminClient, messages };
}

export type Auth = ReturnType<typeof auth>;
