import { randomUUID } from "node:crypto";
import type { OtpSession, SendOtpDeps } from "../otp/deps";
import { sendPhoneOtp, type SendPhoneOtpInput } from "../otp/send";
import { freshIp, freshPhone } from "./harness";
import type { otpTestKit } from "./kit";

/** `send(session, over?, deps?)`: a send with a fresh number, a fresh address and a fresh key unless `over` says otherwise. */
export function makeSend(kit: ReturnType<typeof otpTestKit>) {
  return (s: OtpSession, over: Partial<SendPhoneOtpInput> = {}, d: SendOtpDeps = kit.deps()) =>
    sendPhoneOtp(d, s, {
      phone: freshPhone(),
      ip: freshIp(),
      idempotencyKey: randomUUID(),
      ...over,
    });
}
