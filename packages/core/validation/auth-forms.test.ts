import { expect, it } from "vitest";
import {
  parseConfirmEmailForm,
  parseEmailForm,
  parsePhoneCodeForm,
  parsePhoneForm,
  parseResetForm,
  parseSignInForm,
  parseSignUpForm,
} from "./auth-forms";

const valid = {
  fullName: "  রহিম   উদ্দিন ",
  email: "Rahim@Example.com",
  phone: "০১৭১২৩৪৫৬৭৮",
  password: "Xk9#mQ2$vL7p",
  passwordConfirm: "Xk9#mQ2$vL7p",
  consentTerms: "on",
  consentAup: "on",
  consentPrivacy: "true",
  locale: "en",
};

it("parses a complete sign-up", () => {
  expect(parseSignUpForm(valid)).toEqual({
    ok: true,
    value: {
      fullName: "রহিম উদ্দিন",
      email: "rahim@example.com",
      phone: "+8801712345678",
      password: "Xk9#mQ2$vL7p",
      locale: "en",
    },
  });
});

it("never returns the confirmation or an unknown key", () => {
  const r = parseSignUpForm({ ...valid, extra: "x", accountType: "business", companyName: "Acme" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(Object.keys(r.value).sort()).toEqual(
      ["email", "fullName", "locale", "password", "phone"].sort(),
    );
    expect(JSON.stringify(r.value)).not.toContain("passwordConfirm");
  }
});

it("locale falls back to bn", () => {
  const r = parseSignUpForm({ ...valid, locale: "fr" });
  expect(r.ok && r.value.locale).toBe("bn");
  const r2 = parseSignUpForm({ ...valid, locale: undefined });
  expect(r2.ok && r2.value.locale).toBe("bn");
});

it.each([
  ["fullName", "required", { fullName: undefined }],
  ["fullName", "invalid", { fullName: "a<b" }],
  ["email", "required", { email: undefined }],
  ["email", "invalid", { email: "nope" }],
  ["phone", "required", { phone: "" }],
  ["phone", "invalid", { phone: "12345" }],
  ["password", "required", { password: undefined, passwordConfirm: undefined }],
  ["password", "too_short", { password: "short", passwordConfirm: "short" }],
  ["password", "too_common", { password: "password1234", passwordConfirm: "password1234" }],
  [
    "password",
    "same_as_email",
    { password: "Rahim@Example.com", passwordConfirm: "Rahim@Example.com" },
  ],
  ["password", "repeated", { password: "aaaaaaaaaaaa", passwordConfirm: "aaaaaaaaaaaa" }],
  ["passwordConfirm", "mismatch", { passwordConfirm: "different-1234" }],
  ["consentTerms", "must_accept", { consentTerms: undefined }],
  ["consentAup", "must_accept", { consentAup: "off" }],
  ["consentPrivacy", "must_accept", { consentPrivacy: "" }],
] as const)("%s %s: only that key is reported", (key, code, patch) => {
  const r = parseSignUpForm({ ...valid, ...patch });
  expect(r).toEqual({ ok: false, fields: { [key]: code } });
});

it.each([
  ["array", ["a@x.co"]],
  ["number", 5],
  ["file-like object", { name: "x" }],
])("a %s in a text field is invalid", (_n, v) => {
  expect(parseSignUpForm({ ...valid, fullName: v })).toEqual({
    ok: false,
    fields: { fullName: "invalid" },
  });
});

it("cuts a hostile 1 MB name before any work", () => {
  const t0 = performance.now();
  const r = parseSignUpForm({ ...valid, fullName: "ক".repeat(1_000_000) });
  expect(performance.now() - t0).toBeLessThan(50);
  expect(r).toEqual({ ok: false, fields: { fullName: "too_long" } });
});

it("cuts hostile email, phone and password too", () => {
  expect(parseEmailForm({ email: "a".repeat(1_000_000) })).toEqual({
    ok: false,
    fields: { email: "too_long" },
  });
  expect(parsePhoneForm({ phone: "1".repeat(1_000_000) })).toEqual({
    ok: false,
    fields: { phone: "too_long" },
  });
  expect(parseSignInForm({ email: "a@x.co", password: "p".repeat(1_000_000) })).toEqual({
    ok: false,
    fields: { password: "too_long" },
  });
});

it("sign-in applies no policy", () => {
  expect(parseSignInForm({ email: "A@X.co", password: "x" })).toEqual({
    ok: true,
    value: { email: "a@x.co", password: "x" },
  });
  expect(parseSignInForm({ email: "a@x.co", password: "" })).toEqual({
    ok: false,
    fields: { password: "required" },
  });
  expect(parseSignInForm({ email: "a@x.co", password: "p".repeat(129) })).toEqual({
    ok: false,
    fields: { password: "too_long" },
  });
  expect(parseSignInForm({ email: "bad", password: "x" })).toEqual({
    ok: false,
    fields: { email: "invalid" },
  });
});

it("email form", () => {
  expect(parseEmailForm({ email: " A@x.co " })).toEqual({ ok: true, value: { email: "a@x.co" } });
  expect(parseEmailForm({})).toEqual({ ok: false, fields: { email: "required" } });
  expect(parseEmailForm({ email: "x" })).toEqual({ ok: false, fields: { email: "invalid" } });
});

it("confirm-email form uses the code parser as it is today", () => {
  const f = (code: unknown) => parseConfirmEmailForm({ email: "a@x.co", code });
  expect(f("১২৩৪৫৬")).toEqual({ ok: true, value: { email: "a@x.co", code: "123456" } });
  expect(f("12345")).toEqual({ ok: false, fields: { code: "invalid" } });
  expect(f("1234567")).toEqual({ ok: false, fields: { code: "invalid" } });
  // parseOtpCode removes whitespace, so it accepts this
  expect(f("12 34 56")).toEqual({ ok: true, value: { email: "a@x.co", code: "123456" } });
  expect(f(undefined)).toEqual({ ok: false, fields: { code: "required" } });
  expect(f("1".repeat(17))).toEqual({ ok: false, fields: { code: "too_long" } });
});

it("reset form", () => {
  const ok = { email: "a@x.co", code: "123456", password: "Xk9#mQ2$vL7p" };
  expect(parseResetForm(ok)).toEqual({ ok: true, value: ok });
  expect(parseResetForm({ ...ok, password: "short" })).toEqual({
    ok: false,
    fields: { password: "too_short" },
  });
  const long = { ...ok, email: "rahim.uddin@example.com" };
  expect(parseResetForm({ ...long, password: "rahim.uddin@example.com" })).toEqual({
    ok: false,
    fields: { password: "same_as_email" },
  });
  expect(parseResetForm({ ...ok, passwordConfirm: "other-password-1" })).toEqual({
    ok: false,
    fields: { passwordConfirm: "mismatch" },
  });
  expect(parseResetForm({ ...ok, passwordConfirm: ok.password })).toEqual({ ok: true, value: ok });
});

it("phone forms", () => {
  expect(parsePhoneForm({ phone: "01712345678" })).toEqual({
    ok: true,
    value: { phone: "+8801712345678" },
  });
  expect(parsePhoneForm({ phone: "123" })).toEqual({ ok: false, fields: { phone: "invalid" } });
  expect(parsePhoneCodeForm({ code: "০০০০৪২" })).toEqual({ ok: true, value: { code: "000042" } });
  expect(parsePhoneCodeForm({ code: "42" })).toEqual({ ok: false, fields: { code: "invalid" } });
  expect(parsePhoneCodeForm({})).toEqual({ ok: false, fields: { code: "required" } });
});
