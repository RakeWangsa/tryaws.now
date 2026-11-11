import type { authBn } from "./auth-bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const authEn: Same<typeof authBn> = {
  Auth: {
    meta: {
      login: "Sign in",
      signup: "Create account",
      verify: "Verify",
      forgot: "Forgot password",
      reset: "New password",
    },
    tabs: {
      label: "Sign in or new account",
      login: "Already registered?",
      signup: "Create a new account",
    },
    card: {
      title: "Sign in or create a new account",
      intro: "If you are a returning customer, sign in. If not, create a new account.",
    },
    login: {
      heading: "Existing customer sign in",
      submit: "Sign in",
      forgot: "Forgot password?",
      verified: "Email verified. You can sign in now.",
      reset: "Password changed. Sign in with the new password.",
      verifyLink: "Verify your email",
    },
    signup: {
      heading: "New account",
      personal: "Personal information",
      security: "Account security",
      consents: "Terms",
      submit: "Create account",
    },
    field: {
      fullName: "Full name",
      email: "Email",
      phone: "Mobile number",
      password: "Password",
      passwordConfirm: "Repeat the password",
      code: "Code sent to your email",
      smsCode: "Code sent by SMS",
      newPassword: "New password",
      error: {
        required: "Fill in this field.",
        invalid: "This is not correct. Check it again.",
        too_short: "Use at least {min} characters.",
        too_long: "This is too long. Make it shorter.",
        mismatch: "The two passwords do not match.",
        too_common: "This password is too common. Choose another one.",
        same_as_email: "The password cannot be the same as the email.",
        repeated: "Do not repeat the same character again and again.",
        must_accept: "You need to accept this to continue.",
      },
    },
    hint: {
      password: "At least 12 characters. Do not use a password that is easy to guess.",
      phone: "For example 017XXXXXXXX. A code is sent by SMS.",
      code: "A 6-digit code.",
    },
    consent: {
      terms: "I accept the Terms of Service",
      aup: "I accept the Acceptable Use Policy",
      privacy: "I have read and accept the Privacy Policy",
      read: "Read",
    },
    verify: {
      email: {
        heading: "Verify your email",
        intro:
          "If an account for this address still needs verification, we have sent a code. Enter it here.",
        submit: "Verify",
      },
      resend: "Send the code again",
      resendWait: "You can send it again in {seconds} seconds.",
      phone: {
        heading: "Verify your mobile number",
        intro: "Verify your mobile number with a code that we send by SMS.",
        send: "Send code",
        sent: "A code was sent to {phone}.",
        submit: "Verify",
        resend: "Send the code again",
        notAvailable: "Mobile verification is not available right now",
        notAvailableHint: "Try again in a moment or contact support.",
      },
    },
    forgot: {
      heading: "Forgot your password",
      intro: "Enter your email. If an account exists for it, we send a code.",
      submit: "Send code",
      back: "Back to sign in",
    },
    reset: {
      heading: "New password",
      intro: "Enter the code from your email and a new password.",
      submit: "Change password",
    },
    alert: {
      error: "Error",
      warning: "Warning",
      info: "Information",
      success: "Success",
    },
    error: {
      invalid: "Some details are not correct. Check the marked fields.",
      sign_in_failed:
        "The email or password does not match. If you have not verified your email yet, do that first.",
      code_wrong: "The code is wrong or has expired.",
      rate_limited: "Too many attempts. Try again in {minutes} minutes.",
      unavailable: "This cannot be done right now. Try again in a moment.",
      not_open: "New accounts cannot be created right now.",
      bad_origin: "The request did not come from this site. Open the page again and retry.",
      suspended: "This account is suspended. Contact support.",
      password_rejected: "This password is not accepted. Choose another one.",
      totp_unsupported:
        "This account has an extra security step that does not work here yet. Contact support.",
      ref: "Reference: {ref}",
    },
    state: {
      notAvailableTitle: "This page is not available",
      notAvailableText: "Sign-in is not available right now. Try again in a moment.",
      home: "Back to home",
      errorTitle: "The page could not be opened",
      errorText: "Something went wrong. Try again.",
      retry: "Try again",
    },
    signOut: {
      label: "Sign out",
    },
  },
};
