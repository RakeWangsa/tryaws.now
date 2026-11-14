// WPU-X12 (security review follow-up 1): the server path is the only way to sign up. The customer app
// client is public (no secret), so anyone could call SignUp, ConfirmSignUp or ResendConfirmationCode
// with its id directly at Cognito, past the app's validation, rate limit, terms acceptance and audit
// (R9): e-mail bombing, or an account made with only a user name and a password. Two triggers close it:
// - PreSignUp (functions/cognito-messages/index.ts preSignUp, its own Lambda CognitoPreSignUp) refuses
//   a self sign-up from any client but CustomerSignUpClient;
// - the custom message trigger refuses to render the sign-up and resend codes for any other client, and
//   a trigger that throws makes Cognito send nothing.
// Round 3: the custom message trigger also refuses a customer password-reset code from any other client.
// The id of CustomerSignUpClient (and the customer pool id) reach both functions through SSM (config.ts).
// No configuration refuses every guarded decision (R16). The error texts are fixed and hold no id, user
// name or attribute (R14).

export interface CallerContext {
  readonly awsSdkVersion?: string;
  readonly clientId?: string;
}

/** True only when the call came through the configured sign-up client. */
export function fromSignUpClient(
  event: { readonly callerContext?: CallerContext | null },
  allowed: string | null,
): boolean {
  if (allowed === null) return false;
  const clientId = event.callerContext?.clientId;
  return typeof clientId === "string" && clientId === allowed;
}

export interface PreSignUpEvent {
  readonly version?: string;
  readonly region?: string;
  readonly userPoolId?: string;
  readonly userName?: string;
  readonly triggerSource: string;
  readonly callerContext?: CallerContext | null;
  readonly request: {
    readonly userAttributes?: Readonly<Record<string, string>>;
    readonly validationData?: Readonly<Record<string, string>> | null;
    readonly clientMetadata?: Readonly<Record<string, string>> | null;
  };
  response: {
    autoConfirmUser?: boolean;
    autoVerifyEmail?: boolean;
    autoVerifyPhone?: boolean;
  };
}

const refused = (): never => {
  throw new Error("cognito-presignup: sign-up is not allowed");
};

// PreSignUp_SignUp: only through the sign-up client. PreSignUp_AdminCreateUser: an operator's
// AdminCreateUser, which needs IAM on the pool (no app role has it on the customer pool); allowed.
// PreSignUp_ExternalProvider (the pools have no federation) and anything else: refused. The trigger
// never confirms or verifies a user: the e-mail code stays the proof of the address.
export function preSignUpDecision(event: PreSignUpEvent, allowed: string | null): PreSignUpEvent {
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.triggerSource !== "string" ||
    typeof event.request !== "object" ||
    event.request === null ||
    typeof event.response !== "object" ||
    event.response === null
  ) {
    return refused();
  }
  if (event.triggerSource === "PreSignUp_AdminCreateUser") {
    // AdminCreateUser users are confirmed by Cognito itself; nothing to set here.
    return event;
  }
  if (event.triggerSource !== "PreSignUp_SignUp" || !fromSignUpClient(event, allowed)) {
    return refused();
  }
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;
  event.response.autoVerifyPhone = false;
  return event;
}
