// WPU-X12: only the server-only CustomerSignUpClient may sign up, have a sign-up or resend code sent, or
// (round 3) have a customer password-reset code sent. Its id and the customer pool id come from two SSM
// parameters (round 3: not environment values, which made a dependency cycle), read on a cold start;
// an unreadable or malformed configuration refuses and is not cached (R16).
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_POOL_PARAMETER_ENV,
  SIGN_UP_CLIENT_PARAMETER_ENV,
  guardConfigLoader,
  type GuardConfig,
  type ReadParameters,
} from "./config";
import { fromSignUpClient, preSignUpDecision, type PreSignUpEvent } from "./guard";
import { customMessage, type CustomMessageEvent } from "./handler";
import { makeHandlers } from "./index";

const SIGN_UP_ID = "1example23456789";
const APP_ID = "abcdefghij1234567890";
const ADMIN_APP_ID = "zyxwvutsrq0987654321";
const CUSTOMER_POOL = "ap-southeast-1_Cust0mer1";
const ADMIN_POOL = "ap-southeast-1_Adm1nPool";
const CONFIG: GuardConfig = { signUpClientId: SIGN_UP_ID, customerPoolId: CUSTOMER_POOL };

const CLIENT_PARAM = "/sst/tryaws-now/staging/cognito/signup-client-id";
const POOL_PARAM = "/sst/tryaws-now/staging/cognito/customer-pool-id";
const ENV = {
  [SIGN_UP_CLIENT_PARAMETER_ENV]: CLIENT_PARAM,
  [CUSTOMER_POOL_PARAMETER_ENV]: POOL_PARAM,
};
const GOOD_VALUES = { [CLIENT_PARAM]: SIGN_UP_ID, [POOL_PARAM]: CUSTOMER_POOL };

const preEvent = (triggerSource: string, clientId?: string): PreSignUpEvent => ({
  version: "1",
  region: "ap-southeast-1",
  userPoolId: CUSTOMER_POOL,
  userName: "rahim.uddin@example.test",
  triggerSource,
  callerContext: clientId === undefined ? {} : { awsSdkVersion: "x", clientId },
  request: { userAttributes: { email: "rahim.uddin@example.test" } },
  response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
});

const messageEvent = (
  triggerSource: string,
  clientId?: string,
  userPoolId = CUSTOMER_POOL,
): CustomMessageEvent => ({
  version: "1",
  region: "ap-southeast-1",
  userPoolId,
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

describe("guardConfigLoader (SSM, read on a cold start)", () => {
  it("reads both parameters in one call and caches a good answer for the container", async () => {
    const read = vi.fn<ReadParameters>(async () => GOOD_VALUES);
    const load = guardConfigLoader(ENV, read);
    expect(await load()).toEqual(CONFIG);
    expect(await load()).toEqual(CONFIG);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([CLIENT_PARAM, POOL_PARAM]);
  });

  it("a failed read refuses and is not cached: the next call reads again", async () => {
    const read = vi
      .fn<ReadParameters>()
      .mockRejectedValueOnce(new Error(`AccessDenied ${SIGN_UP_ID}`))
      .mockResolvedValueOnce(GOOD_VALUES);
    const load = guardConfigLoader(ENV, read);
    expect(await load()).toBeNull();
    expect(await load()).toEqual(CONFIG);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a missing client id", { [POOL_PARAM]: CUSTOMER_POOL }],
    ["a missing pool id", { [CLIENT_PARAM]: SIGN_UP_ID }],
    ["a malformed client id", { ...GOOD_VALUES, [CLIENT_PARAM]: "has space 1234567890" }],
    ["a malformed pool id", { ...GOOD_VALUES, [POOL_PARAM]: "nope" }],
    ["an empty answer", {}],
  ])("%s refuses and is not cached", async (_label, values) => {
    const read = vi
      .fn<ReadParameters>()
      .mockResolvedValueOnce(values as Record<string, string>)
      .mockResolvedValueOnce(GOOD_VALUES);
    const load = guardConfigLoader(ENV, read);
    expect(await load()).toBeNull();
    expect(await load()).toEqual(CONFIG);
  });

  it("without the parameter names nothing is read and everything is refused", async () => {
    const read = vi.fn<ReadParameters>(async () => GOOD_VALUES);
    for (const env of [
      {},
      { [SIGN_UP_CLIENT_PARAMETER_ENV]: CLIENT_PARAM },
      { ...ENV, [CUSTOMER_POOL_PARAMETER_ENV]: "no-slash" },
    ]) {
      expect(await guardConfigLoader(env, read)()).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("two calls during one cold start share one read", async () => {
    let release: (v: Record<string, string>) => void = () => {};
    const read = vi.fn<ReadParameters>(
      () => new Promise<Record<string, string>>((resolve) => (release = resolve)),
    );
    const load = guardConfigLoader(ENV, read);
    const a = load();
    const b = load();
    release(GOOD_VALUES);
    expect(await a).toEqual(CONFIG);
    expect(await b).toEqual(CONFIG);
    expect(read).toHaveBeenCalledTimes(1);
  });
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

  it("refuses a self sign-up through any other client, with no client, or with no configuration", () => {
    for (const [event, allowed] of [
      [preEvent("PreSignUp_SignUp", APP_ID), SIGN_UP_ID],
      [preEvent("PreSignUp_SignUp", "CLIENT_ID_NOT_APPLICABLE"), SIGN_UP_ID],
      [preEvent("PreSignUp_SignUp"), SIGN_UP_ID],
      [preEvent("PreSignUp_SignUp", SIGN_UP_ID), null],
    ] as const) {
      expect(() => preSignUpDecision(event, allowed)).toThrow(
        "cognito-presignup: sign-up is not allowed",
      );
    }
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

  it("a malformed event is refused with the fixed message, which holds no value", () => {
    for (const bad of [undefined, null, {}, { triggerSource: "PreSignUp_SignUp" }]) {
      expect(() => preSignUpDecision(bad as never, SIGN_UP_ID)).toThrow(
        "cognito-presignup: sign-up is not allowed",
      );
    }
    try {
      preSignUpDecision(preEvent("PreSignUp_SignUp", APP_ID), SIGN_UP_ID);
    } catch (e) {
      for (const value of [APP_ID, SIGN_UP_ID, "rahim.uddin@example.test"]) {
        expect((e as Error).message).not.toContain(value);
      }
    }
  });
});

describe("customMessage: which codes go out for which client", () => {
  const REFUSED = "cognito-messages: the code is sent only for the sign-up client";

  it.each(["CustomMessage_SignUp", "CustomMessage_ResendCode"])(
    "%s only for the sign-up client, on any pool, never without configuration",
    (source) => {
      expect(
        customMessage(messageEvent(source, SIGN_UP_ID), CONFIG).response.emailMessage,
      ).toContain("{####}");
      for (const event of [messageEvent(source, APP_ID), messageEvent(source)]) {
        expect(() => customMessage(event, CONFIG)).toThrow(REFUSED);
      }
      expect(() => customMessage(messageEvent(source, SIGN_UP_ID), null)).toThrow(REFUSED);
    },
  );

  it("a customer password-reset code only for the sign-up client (round 3)", () => {
    const ok = customMessage(messageEvent("CustomMessage_ForgotPassword", SIGN_UP_ID), CONFIG);
    expect(ok.response.emailSubject).toBe("TryAWS.now: your password reset code");
    for (const event of [
      messageEvent("CustomMessage_ForgotPassword", APP_ID),
      messageEvent("CustomMessage_ForgotPassword"),
    ]) {
      expect(() => customMessage(event, CONFIG)).toThrow(REFUSED);
    }
  });

  it("the admin pool's reset still goes out through the admin client", () => {
    const out = customMessage(
      messageEvent("CustomMessage_ForgotPassword", ADMIN_APP_ID, ADMIN_POOL),
      CONFIG,
    );
    expect(out.response.emailSubject).toBe("TryAWS.now: your password reset code");
    expect(out.response.emailMessage).toContain("{####}");
  });

  it("without configuration a reset is refused on every pool (the pool cannot be told apart, R16)", () => {
    for (const pool of [CUSTOMER_POOL, ADMIN_POOL]) {
      expect(() =>
        customMessage(messageEvent("CustomMessage_ForgotPassword", SIGN_UP_ID, pool), null),
      ).toThrow(REFUSED);
    }
  });

  it("the admin invite and the attribute codes do not depend on the client or the configuration", () => {
    for (const source of [
      "CustomMessage_AdminCreateUser",
      "CustomMessage_VerifyUserAttribute",
      "CustomMessage_UpdateUserAttribute",
    ]) {
      const out = customMessage(messageEvent(source, ADMIN_APP_ID, ADMIN_POOL), null);
      expect(out.response.emailMessage, source).toContain("{####}");
    }
  });
});

describe("the handlers read the configuration only when a decision needs it", () => {
  it("preSignUp: the sign-up client passes, the public app client and an unreadable configuration do not", async () => {
    const good = makeHandlers(async () => CONFIG);
    const ok = preEvent("PreSignUp_SignUp", SIGN_UP_ID);
    await expect(good.preSignUp(ok)).resolves.toBe(ok);
    await expect(good.preSignUp(preEvent("PreSignUp_SignUp", APP_ID))).rejects.toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
    const broken = makeHandlers(async () => null);
    await expect(broken.preSignUp(preEvent("PreSignUp_SignUp", SIGN_UP_ID))).rejects.toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
  });

  it("handler: guarded sources load the configuration; the admin invite does not", async () => {
    const load = vi.fn(async () => CONFIG);
    const { handler } = makeHandlers(load);
    await handler(messageEvent("CustomMessage_AdminCreateUser", ADMIN_APP_ID, ADMIN_POOL));
    expect(load).not.toHaveBeenCalled();
    await handler(messageEvent("CustomMessage_ForgotPassword", ADMIN_APP_ID, ADMIN_POOL));
    expect(load).toHaveBeenCalledTimes(1);
    await expect(handler(messageEvent("CustomMessage_ResendCode", APP_ID))).rejects.toThrow(
      "cognito-messages: the code is sent only for the sign-up client",
    );
  });

  it("a load that throws is a refusal, never an allowance", async () => {
    const { handler, preSignUp } = makeHandlers(async () => {
      throw new Error("boom");
    });
    await expect(handler(messageEvent("CustomMessage_SignUp", SIGN_UP_ID))).rejects.toThrow();
    await expect(preSignUp(preEvent("PreSignUp_SignUp", SIGN_UP_ID))).rejects.toThrow(
      "cognito-presignup: sign-up is not allowed",
    );
  });
});
