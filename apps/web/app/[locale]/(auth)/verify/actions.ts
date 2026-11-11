"use server";

import { formOf, runAction } from "../../../../server/auth-wrap.ts";
import { confirmEmailCore } from "../../../../server/auth/confirm-email.ts";
import { sendPhoneCodeCore, verifyPhoneCodeCore } from "../../../../server/auth/phone.ts";
import { resendEmailCodeCore } from "../../../../server/auth/resend-email-code.ts";
import type { FormState } from "../../../../server/auth/state.ts";

/** The email code of a new account. */
export async function confirmEmailAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => confirmEmailCore(ctx, formOf(data)));
}

/** "Send the code again" for the email step. */
export async function resendEmailCodeAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => resendEmailCodeCore(ctx, formOf(data)));
}

/** The phone step: send an SMS code. The customer is the session's, never a field. */
export async function sendPhoneCodeAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => sendPhoneCodeCore(ctx, formOf(data)));
}

/** The phone step: check the SMS code. */
export async function verifyPhoneCodeAction(_prev: FormState, data: FormData): Promise<FormState> {
  return runAction((ctx) => verifyPhoneCodeCore(ctx, formOf(data)));
}
