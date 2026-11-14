// WPU-X12 (security review follow-up 1): the public CustomerAppClient must not reach SignUp or the
// confirmation-code e-mails at Cognito directly. Only the server-only CustomerSignUpClient, whose id the
// stack gives both trigger functions as SIGN_UP_CLIENT_ID (an id, not a secret), may sign up or have a
// sign-up code sent. Everything else is refused, and an unreadable configuration refuses too (R16).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIGN_UP_CLIENT_ENV,
  fromSignUpClient,
  preSignUpDecision,
  signUpClientIdFrom,
  type PreSignUpEvent,
} from "./guard";
import { handler, preSignUp } from "./index";
import type { CustomMessageEvent } from "./handler";

const SIGN_UP_ID = "1example23456789";
const APP_ID = "abcdefghij1234567890";

afterEach(() => {
  vi.unstubAllEnvs();
});

const preEvent = (triggerSource: string, clientId?: string): PreSignUpEvent => ({
  version: "1",
  region: "ap-southeast-1",
  userPoolId: "ap-southeast-1_AbC123xyz",
  userName: "rahim.uddin@example.test",
  triggerSource,
  callerContext: clientId === undefined ? {} : { awsSdkVersion: "x", clientId },
  request: { userAttributes: { email: "rahim.uddin@example.test" } },
  response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
});

const messageEvent = (triggerSource: string, clientId?: string): CustomMessageEvent => ({
  version: "1",
  region: "ap-southeast-1",
  userPoolId: "ap-southeast-1_AbC123xyz",
  userName: "rahim.uddin@example.test",
  triggerSource,
  ...(clientId === undefined ? {} : { callerContext: { awsSdkVersion: "x", clientId } }),
  request: {
    userAttributes: { email: "rahim.uddin@example.test" },
    codeParameter: "{####}",
    usernameParameter: "{username}",
    clientMetadata: { locale: "en" },
  },
  response: { smsMessage: "", emailMessage: "", emailSubject: "" },
});

describe("signUpClientIdFrom", () => {
  it("reads the id from SIGN_UP_CLIENT_ID", () => {
    expect(SIGN_UP_CLIENT_ENV).toBe("SIGN_UP_CLIENT_ID");
    expect(signUpClientIdFrom({ SIGN_UP_CLIENT_ID: SIGN_UP_ID })).toBe(SIGN_UP_ID);
  });

  it.each([undefined, "", "short", "has space 1234567890", "x".repeat(65), "a-b-c-d-e-f-g"])(
    "a missing or malformed id is null: %j",
    (value) => {
      expect(signUpClientIdFrom({ SIGN_UP_CLIENT_ID: value })).toBeNull();
    },
  );
});

describe("fromSignUpClient", () => {
  it("is true only for the sign-up client's own id", () => {
    expect(fromSignUpClient({ callerContext: { clientId: SIGN_UP_ID } }, SIGN_UP_ID)).toBe(true);
    expect(fromSignUpClient({ callerContext: { clientId: APP_ID } }, SIGN_UP_ID)).toBe(false);
    expect(fromSignUpClient({ callerContext: {} }, SIGN_UP_ID)).toBe(false);
    expect(fromSignUpClient({}, SIGN_UP_ID)).toBe(false);
    expect(fromSignUpClient({ callerContext: { clientId: `${SIGN_UP_ID} ` } }, SIGN_UP_ID)).toBe(
      false,
    );
  });

  it("with no configured id nothing is from the sign-up client (R16)", () => {
    expect(fromSignUpClient({ callerContext: { clientId: SIGN_UP_ID } }, null)).toBe(false);
    expect(fromSignUpClient({ callerContext: { clientId: "" } }, null)).toBe(false);
  });
});

describe("preSignUpDecision", () => {
  it("allows a self sign-up through the sign-up client and confirms nothing itself", () => {
    const event = preEvent("PreSignUp_SignUp", SIGN_UP_ID);
    const out = preSignUpDecision(event, SIGN_UP_ID);
    expect(out).toBe(event);
    expect(out.response).toEqual({
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    });
  });

  it("refuses a self sign-up through any other client, or with no client", () => {
    for (const event of [
      preEvent("PreSignUp_SignUp", APP_ID),
      preEvent("PreSignUp_SignUp", "CLIENT_ID_NOT_APPLICABLE"),
      preEvent("PreSignUp_SignUp"),
    ]) {
      expect(() => preSignUpDecision(event, SIGN_UP_ID)).toThrow(
        "cognito-presignup: sign-up is not allowed",
      );
    }
  });

  it("refuses every self sign-up when the id is not configured (R16)", () => {
    expect(() => preSignUpDecision(preEvent("PreSignUp_SignUp", SIGN_UP_ID), null)).toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
  });

  it("lets an operator's AdminCreateUser (IAM only) through, refuses external providers and unknown sources", () => {
    const admin = preEvent("PreSignUp_AdminCreateUser", "CLIENT_ID_NOT_APPLICABLE");
    expect(preSignUpDecision(admin, SIGN_UP_ID)).toBe(admin);
    for (const source of ["PreSignUp_ExternalProvider", "PreSignUp_Other", ""]) {
      expect(() => preSignUpDecision(preEvent(source, SIGN_UP_ID), SIGN_UP_ID), source).toThrow(
        "cognito-presignup: sign-up is not allowed",
      );
    }
  });

  it("never turns on auto-confirmation, even when an event asks for it", () => {
    const event = preEvent("PreSignUp_SignUp", SIGN_UP_ID);
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
    const out = preSignUpDecision(event, SIGN_UP_ID);
    expect(out.response.autoConfirmUser).toBe(false);
    expect(out.response.autoVerifyEmail).toBe(false);
  });

  it("a malformed event is refused with the fixed message", () => {
    for (const bad of [undefined, null, {}, { triggerSource: "PreSignUp_SignUp" }]) {
      expect(() => preSignUpDecision(bad as never, SIGN_UP_ID)).toThrow(
        "cognito-presignup: sign-up is not allowed",
      );
    }
  });

  it("the error text holds no client id, user name or attribute", () => {
    try {
      preSignUpDecision(preEvent("PreSignUp_SignUp", APP_ID), SIGN_UP_ID);
    } catch (e) {
      const message = (e as Error).message;
      for (const value of [APP_ID, SIGN_UP_ID, "rahim.uddin@example.test"]) {
        expect(message).not.toContain(value);
      }
    }
  });
});

describe("the handlers read SIGN_UP_CLIENT_ID", () => {
  it("preSignUp allows the sign-up client and refuses the public app client", async () => {
    vi.stubEnv("SIGN_UP_CLIENT_ID", SIGN_UP_ID);
    const ok = preEvent("PreSignUp_SignUp", SIGN_UP_ID);
    await expect(preSignUp(ok)).resolves.toBe(ok);
    await expect(preSignUp(preEvent("PreSignUp_SignUp", APP_ID))).rejects.toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
  });

  it("preSignUp refuses everything without the variable", async () => {
    vi.stubEnv("SIGN_UP_CLIENT_ID", undefined);
    await expect(preSignUp(preEvent("PreSignUp_SignUp", SIGN_UP_ID))).rejects.toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
  });

  it.each(["CustomMessage_SignUp", "CustomMessage_ResendCode"])(
    "the custom message %s is sent only for the sign-up client (a throw stops the e-mail)",
    async (source) => {
      vi.stubEnv("SIGN_UP_CLIENT_ID", SIGN_UP_ID);
      const out = await handler(messageEvent(source, SIGN_UP_ID));
      expect(out.response.emailMessage).toContain("{####}");
      for (const event of [messageEvent(source, APP_ID), messageEvent(source)]) {
        await expect(handler(event)).rejects.toThrow(
          "cognito-messages: the code is sent only for the sign-up client",
        );
      }
      vi.stubEnv("SIGN_UP_CLIENT_ID", undefined);
      await expect(handler(messageEvent(source, SIGN_UP_ID))).rejects.toThrow(
        "cognito-messages: the code is sent only for the sign-up client",
      );
    },
  );

  it("the other messages do not depend on the client (reset, admin invite, attribute codes)", async () => {
    vi.stubEnv("SIGN_UP_CLIENT_ID", undefined);
    for (const source of [
      "CustomMessage_ForgotPassword",
      "CustomMessage_AdminCreateUser",
      "CustomMessage_VerifyUserAttribute",
      "CustomMessage_UpdateUserAttribute",
    ]) {
      const out = await handler(messageEvent(source, APP_ID));
      expect(out.response.emailMessage, source).toContain("{####}");
    }
  });
});
