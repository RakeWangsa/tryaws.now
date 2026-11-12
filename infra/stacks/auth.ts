// WP0-T4: Cognito pools for customers and admins (6.1, 6.2). Both send e-mail through SES. The
// custom-message trigger (functions/cognito-messages) renders the e-mails; it reads no database and
// assumes no role (3.2), so it runs outside the VPC with no links.
//
// NOT TYPE-CHECKED, see network.ts.
import { resourceName, roleName, type StageConfig } from "../lib/stage";

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

  const email = {
    // Cognito sends through the verified SES identity (not the default Cognito sender).
    emailSendingAccount: "DEVELOPER",
    sourceArn: config.sesIdentityArn,
    fromEmailAddress: config.sesFromAddress,
  };

  // The trigger function: one Lambda for both pools.
  const messages = new sst.aws.Function("CognitoMessages", {
    handler: "functions/cognito-messages/index.handler",
    // 3.2 sizes: a short function; the e-mail must stay under 20,000 characters.
    timeout: "5 seconds",
    memory: "256 MB",
    transform: {
      role: (args: { name?: string }) => {
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
      userPool: (args: Record<string, unknown>) => {
        args.name = resourceName(stage, "customers");
        args.passwordPolicy = PASSWORD_POLICY;
        args.autoVerifiedAttributes = ["email"];
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
  const customerClient = customers.addClient("Web", {
    transform: {
      client: (args: Record<string, unknown>) => {
        // No client secret: the Next.js server uses the SRP or password flow of the SDK.
        // VERIFY: transform.client key of CognitoUserPool.addClient and the auth flows 6.1 needs.
        args.generateSecret = false;
        args.explicitAuthFlows = [
          "ALLOW_USER_PASSWORD_AUTH",
          "ALLOW_REFRESH_TOKEN_AUTH",
          "ALLOW_USER_SRP_AUTH",
        ];
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
      userPool: (args: Record<string, unknown>) => {
        args.name = resourceName(stage, "admins");
        args.passwordPolicy = PASSWORD_POLICY;
        args.autoVerifiedAttributes = ["email"];
        args.emailConfiguration = email;
        args.deletionProtection = "ACTIVE";
        // No self sign-up (6.2): only an administrator creates users.
        args.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
        // TOTP only: no SMS second factor.
        args.softwareTokenMfaConfiguration = { enabled: true };
      },
    },
  });
  const adminClient = admins.addClient("Admin", {
    transform: {
      client: (args: Record<string, unknown>) => {
        args.generateSecret = false;
        // Short sessions: 8 hours (6.2). VERIFY: units; Cognito allows refresh 60 minutes to 10 years.
        args.refreshTokenValidity = 8;
        args.accessTokenValidity = 1;
        args.idTokenValidity = 1;
        args.tokenValidityUnits = { refreshToken: "hours", accessToken: "hours", idToken: "hours" };
        args.preventUserExistenceErrors = "ENABLED";
      },
    },
  });

  return { customers, customerClient, admins, adminClient, messages };
}

export type Auth = ReturnType<typeof auth>;
