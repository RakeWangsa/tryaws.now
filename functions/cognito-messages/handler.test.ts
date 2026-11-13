import { expect, it } from "vitest";
import { handler } from "./index";
import { localeOf, type CustomMessageEvent } from "./handler";

const eventOf = (
  triggerSource: string,
  over: {
    clientMetadata?: Record<string, string>;
    userAttributes?: Record<string, string>;
    codeParameter?: string;
    usernameParameter?: string;
  } = {},
): CustomMessageEvent => ({
  version: "1",
  region: "ap-southeast-1",
  userPoolId: "pool",
  userName: "rahim.uddin@example.test",
  triggerSource,
  request: {
    userAttributes: over.userAttributes ?? { email: "rahim.uddin@example.test" },
    codeParameter: over.codeParameter ?? "{####}",
    usernameParameter: over.usernameParameter ?? "{username}",
    clientMetadata: over.clientMetadata,
  },
  response: { smsMessage: "", emailMessage: "", emailSubject: "" },
});

it("exports the handler that the stack wires", () => {
  expect(typeof handler).toBe("function");
});

it("sign-up, resend, verify and update attribute send the verification message", async () => {
  for (const source of [
    "CustomMessage_SignUp",
    "CustomMessage_ResendCode",
    "CustomMessage_VerifyUserAttribute",
    "CustomMessage_UpdateUserAttribute",
  ]) {
    const out = await handler(eventOf(source, { clientMetadata: { locale: "en" } }));
    expect(out.response.emailSubject, source).toBe("TryAWS.now: your email verification code");
    expect(out.response.emailMessage, source).toContain("verification code");
    expect(out.response.emailMessage).toContain("{####}");
  }
});

it("forgot password sends the reset message", async () => {
  const out = await handler(
    eventOf("CustomMessage_ForgotPassword", { clientMetadata: { locale: "en" } }),
  );
  expect(out.response.emailSubject).toBe("TryAWS.now: your password reset code");
  expect(out.response.emailMessage).toContain("{####}");
});

it("an admin's new account gets the temporary-password message with the username placeholder", async () => {
  const out = await handler(
    eventOf("CustomMessage_AdminCreateUser", { clientMetadata: { locale: "en" } }),
  );
  expect(out.response.emailSubject).toBe("TryAWS.now admin: your temporary password");
  expect(out.response.emailMessage).toContain("{####}");
  expect(out.response.emailMessage).toContain("{username}");
});

it("returns the same event object, with the SMS message untouched", async () => {
  const event = eventOf("CustomMessage_SignUp");
  event.response.smsMessage = "keep";
  const out = await handler(event);
  expect(out).toBe(event);
  expect(out.response.smsMessage).toBe("keep");
});

it("picks the locale: client metadata, then the user attribute, then bn", () => {
  expect(localeOf(eventOf("x", { clientMetadata: { locale: "en" } }))).toBe("en");
  expect(
    localeOf(eventOf("x", { clientMetadata: { locale: "en" }, userAttributes: { locale: "bn" } })),
  ).toBe("en");
  expect(localeOf(eventOf("x", { userAttributes: { locale: "en" } }))).toBe("en");
  expect(localeOf(eventOf("x", { userAttributes: { "custom:locale": "en" } }))).toBe("en");
  expect(localeOf(eventOf("x"))).toBe("bn");
  // a value that is not exactly bn or en is not trusted
  expect(localeOf(eventOf("x", { clientMetadata: { locale: "en-US" } }))).toBe("bn");
  expect(localeOf(eventOf("x", { clientMetadata: { locale: "<script>" } }))).toBe("bn");
  expect(
    localeOf(eventOf("x", { clientMetadata: { locale: "xx" }, userAttributes: { locale: "en" } })),
  ).toBe("en");
});

it("renders Bengali by default", async () => {
  const out = await handler(eventOf("CustomMessage_SignUp"));
  expect(out.response.emailMessage).toContain('lang="bn"');
  expect(out.response.emailSubject).toMatch(/[ঀ-৿]/);
});

it("never puts a user attribute or the user name into the message", async () => {
  const hostile = "<script>alert(1)</script>";
  const out = await handler({
    ...eventOf("CustomMessage_SignUp", {
      userAttributes: { email: hostile, name: hostile, locale: "en" },
      clientMetadata: { locale: "en", note: hostile },
    }),
    userName: hostile,
  });
  expect(out.response.emailMessage).not.toContain("<script");
  expect(out.response.emailMessage).not.toContain("alert(1)");
  expect(out.response.emailSubject).not.toContain("alert");
});

it("leaves the event as Cognito made it for a source it does not handle (the MFA SMS)", async () => {
  const event = eventOf("CustomMessage_Authentication");
  const out = await handler(event);
  expect(out.response).toEqual({ smsMessage: "", emailMessage: "", emailSubject: "" });
});

it("fails closed with a fixed message when the placeholder is not Cognito's own", async () => {
  for (const codeParameter of ["", "123456", "<b>{####}</b>"]) {
    await expect(handler(eventOf("CustomMessage_SignUp", { codeParameter }))).rejects.toThrow(
      "cognito-messages: could not render the message",
    );
  }
  await expect(
    handler(eventOf("CustomMessage_AdminCreateUser", { usernameParameter: "bob" })),
  ).rejects.toThrow("cognito-messages: could not render the message");
});

it("a malformed event fails closed", async () => {
  for (const bad of [undefined, null, {}, { triggerSource: "CustomMessage_SignUp" }]) {
    await expect(handler(bad as never)).rejects.toThrow(
      "cognito-messages: could not render the message",
    );
  }
});
