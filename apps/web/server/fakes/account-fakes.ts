import type { CustomerSession } from "@tc/auth";
import type { AccountPort, AccountPorts, PhoneOtpPort } from "../settings-actions.ts";

// Development and test only (see eps-bridge.ts): an identity provider and an OTP service that live
// in memory. The code they accept is always DEV_CODE; nothing is sent anywhere. The production
// runtime does not load this file (runtime.ts, config.fakes).

export const DEV_CODE = "123456";
export const DEV_PASSWORD = "dev-current-password";

export class FakeAccount implements AccountPort {
  readonly calls: string[] = [];
  private readonly passwords = new Map<string, string>();
  private readonly pendingEmail = new Map<string, string>();
  readonly emails = new Map<string, string>();

  private passwordOf(customerId: string): string {
    return this.passwords.get(customerId) ?? DEV_PASSWORD;
  }

  async changePassword(i: { customerId: string; currentPassword: string; newPassword: string }) {
    this.calls.push("changePassword");
    if (i.currentPassword !== this.passwordOf(i.customerId)) {
      return { ok: false, kind: "invalid_password" } as const;
    }
    this.passwords.set(i.customerId, i.newPassword);
    return { ok: true, value: true } as const;
  }

  async startEmailChange(i: { customerId: string; newEmail: string }) {
    this.calls.push("startEmailChange");
    this.pendingEmail.set(i.customerId, i.newEmail);
    return { ok: true, value: true } as const;
  }

  async confirmEmailChange(i: { customerId: string; newEmail: string; code: string }) {
    this.calls.push("confirmEmailChange");
    if (this.pendingEmail.get(i.customerId) !== i.newEmail) {
      return { ok: false, kind: "expired_code" } as const;
    }
    if (i.code !== DEV_CODE) return { ok: false, kind: "invalid_code" } as const;
    this.pendingEmail.delete(i.customerId);
    this.emails.set(i.customerId, i.newEmail);
    return { ok: true, value: true } as const;
  }
}

export class FakePhoneOtp implements PhoneOtpPort {
  readonly calls: string[] = [];
  private readonly open = new Map<string, string>();

  async send(session: CustomerSession, input: { phone: string }) {
    this.calls.push("send");
    this.open.set(session.customerId, input.phone);
    const masked = `${input.phone.slice(0, 6)}••••${input.phone.slice(-2)}`;
    return {
      ok: true,
      value: {
        challengeId: "00000000-0000-8000-8000-000000000000",
        phoneMasked: masked,
        expiresAt: new Date(Date.now() + 300_000),
        resendAt: new Date(Date.now() + 60_000),
        replayed: false,
      },
    } as const;
  }

  async verify(session: CustomerSession, input: { code: string }) {
    this.calls.push("verify");
    const phone = this.open.get(session.customerId);
    if (phone === undefined) return { ok: false, error: "not_found" } as const;
    if (input.code !== DEV_CODE) {
      return { ok: false, error: "validation", fields: { code: "wrong" } } as const;
    }
    this.open.delete(session.customerId);
    return {
      ok: true,
      value: {
        phoneMasked: `${phone.slice(0, 6)}••••${phone.slice(-2)}`,
        verifiedAt: new Date(),
      },
    } as const;
  }
}

export function getDevAccount(): AccountPorts {
  const holder = globalThis as unknown as Record<string, AccountPorts | undefined>;
  holder["__tcDevAccount"] ??= { account: new FakeAccount(), otp: new FakePhoneOtp() };
  return holder["__tcDevAccount"];
}
