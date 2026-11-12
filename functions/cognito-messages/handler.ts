import type { Locale } from "@tc/core";
import { renderCognitoMessage, type CognitoMessageKind } from "@tc/notify";

// The Cognito "custom message" trigger of both pools (3.2, 6, 16.14). Cognito calls it before it sends
// a code and lets it replace the email subject and body; Cognito then puts the code (and the user
// name) into the literal placeholders `{####}` and `{username}`. The function reads nothing from the
// database and calls nothing: it picks a fixed message by `triggerSource` and a language, and renders
// it from packages/notify. No attribute, user name or client metadata value reaches the message (R14,
// and the HTML is built from fixed text only); the locale is one of two exact strings.

export interface CustomMessageEvent {
  readonly version?: string;
  readonly region?: string;
  readonly userPoolId?: string;
  readonly userName?: string;
  readonly triggerSource: string;
  readonly request: {
    readonly userAttributes?: Readonly<Record<string, string>>;
    readonly codeParameter: string;
    readonly usernameParameter?: string;
    readonly clientMetadata?: Readonly<Record<string, string>> | null;
  };
  response: {
    smsMessage?: string | null;
    emailMessage?: string | null;
    emailSubject?: string | null;
  };
}

const KIND_OF: Readonly<Record<string, CognitoMessageKind>> = {
  CustomMessage_SignUp: "verify_code",
  CustomMessage_ResendCode: "verify_code",
  CustomMessage_VerifyUserAttribute: "verify_code",
  CustomMessage_UpdateUserAttribute: "verify_code",
  CustomMessage_ForgotPassword: "reset_code",
  CustomMessage_AdminCreateUser: "admin_temp_password",
};

const isLocale = (v: unknown): v is Locale => v === "bn" || v === "en";

// Client metadata first (the panel passes the language of the page), then the user's own attribute,
// then Bengali. Anything that is not exactly "bn" or "en" is skipped.
export function localeOf(event: CustomMessageEvent): Locale {
  const attrs = event.request.userAttributes;
  for (const candidate of [
    event.request.clientMetadata?.locale,
    attrs?.locale,
    attrs?.["custom:locale"],
  ]) {
    if (isLocale(candidate)) return candidate;
  }
  return "bn";
}

export function customMessage(event: CustomMessageEvent): CustomMessageEvent {
  const fail = (): never => {
    throw new Error("cognito-messages: could not render the message");
  };
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.triggerSource !== "string" ||
    typeof event.request !== "object" ||
    event.request === null ||
    typeof event.response !== "object" ||
    event.response === null
  ) {
    return fail();
  }
  const kind = Object.hasOwn(KIND_OF, event.triggerSource)
    ? KIND_OF[event.triggerSource]
    : undefined;
  // Any other source (the SMS MFA code, for one) keeps the message Cognito made.
  if (kind === undefined) return event;
  try {
    const rendered = renderCognitoMessage(kind, localeOf(event), {
      code: event.request.codeParameter,
      ...(kind === "admin_temp_password" ? { username: event.request.usernameParameter } : {}),
    });
    event.response.emailSubject = rendered.subject;
    event.response.emailMessage = rendered.html;
    return event;
  } catch {
    return fail();
  }
}
