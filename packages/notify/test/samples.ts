import type { Channel, TemplateId } from "../queue/types";

// One valid data object per template, and the channels that 16.14 gives it. Fixed fake ids.
export const IDS = {
  customer: "0193f7c2-5b8a-7c3e-9a1b-1234567890ab",
  submission: "0193f7c2-5b8b-7d4f-8a2c-23456789abcd",
  payment: "0193f7c3-1a2b-7e5f-9b3d-3456789abcde",
  order: "0193f7c4-2b3c-7f60-8c4e-456789abcdef",
  invoice: "0193f7c4-2b3d-7071-9d5f-56789abcdef0",
  resource: "0193f7c5-3c4d-7182-8e60-6789abcdef01",
  subscription: "0193f7c5-3c4e-7293-9f71-789abcdef012",
} as const;

const at = "2026-11-10T20:00:00.000Z";
const res = { resourceId: IDS.resource, product: "instance", label: "web-1" } as const;

export const SAMPLES: Record<TemplateId, { data: Record<string, unknown>; channels: Channel[] }> = {
  welcome: { data: {}, channels: ["email", "in_app"] },
  kyc_received: { data: { submissionId: IDS.submission }, channels: ["email", "in_app"] },
  kyc_approved: { data: { submissionId: IDS.submission }, channels: ["email", "sms", "in_app"] },
  kyc_rejected: {
    data: { submissionId: IDS.submission, reason: "The photo is blurred" },
    channels: ["email", "in_app"],
  },
  topup_receipt: {
    data: { paymentId: IDS.payment, amountMinor: "150000", balanceMinor: 300000n, creditedAt: at },
    channels: ["email", "in_app"],
  },
  order_paid: {
    data: {
      orderId: IDS.order,
      invoiceId: IDS.invoice,
      invoiceNumber: "TC-2026-000123",
      product: "instance",
      totalMinor: "99900",
      balanceMinor: "200100",
      paidAt: at,
    },
    channels: ["email", "in_app"],
  },
  order_failed_refunded: {
    data: {
      orderId: IDS.order,
      product: "database",
      failure: "create_failed",
      refundMinor: "99900",
      balanceMinor: "300000",
    },
    channels: ["email", "in_app"],
  },
  resource_ready: {
    data: { ...res, regionCode: "ap-southeast-1", address: "203.0.113.10" },
    channels: ["email", "sms", "in_app"],
  },
  renewal_reminder: {
    data: {
      subscriptionId: IDS.subscription,
      ...res,
      days: 1,
      periodEnd: at,
      amountMinor: "99900",
      balanceMinor: "5000",
      autoRenew: true,
    },
    channels: ["email", "sms", "in_app"],
  },
  renewed: {
    data: {
      subscriptionId: IDS.subscription,
      resourceId: IDS.resource,
      product: "instance",
      invoiceId: IDS.invoice,
      invoiceNumber: "TC-2026-000124",
      totalMinor: "99900",
      balanceMinor: "100000",
      periodEnd: at,
    },
    channels: ["email", "in_app"],
  },
  grace_started: {
    data: {
      subscriptionId: IDS.subscription,
      ...res,
      graceUntil: at,
      amountMinor: "99900",
      balanceMinor: "0",
    },
    channels: ["email", "sms", "in_app"],
  },
  resource_destroyed: {
    data: { subscriptionId: IDS.subscription, ...res, restoreUntil: at, kept: "backup" },
    channels: ["email", "sms", "in_app"],
  },
  backups_purged: {
    data: { subscriptionId: IDS.subscription, ...res, purgedAt: at, kept: "backup" },
    channels: ["email", "in_app"],
  },
  low_balance: {
    data: { balanceMinor: "1000", dueMinor: "99900", windowDays: 7 },
    channels: ["email", "in_app"],
  },
  payment_expired: {
    data: { paymentId: IDS.payment, amountMinor: "50000" },
    channels: ["email", "in_app"],
  },
  security_new_sign_in: { data: { at, ip: "203.0.113.7" }, channels: ["email", "sms", "in_app"] },
  security_password_changed: { data: { at }, channels: ["email", "sms", "in_app"] },
  security_totp_changed: { data: { at }, channels: ["email", "sms", "in_app"] },
  security_email_changed: { data: { at }, channels: ["email", "sms", "in_app"] },
  security_phone_changed: { data: { at }, channels: ["email", "sms", "in_app"] },
  domain_contact_pending: { data: { domain: "example.com" }, channels: ["email", "in_app"] },
  domain_renewal_reminder: {
    data: { domain: "example.com", days: 7, expiresAt: at },
    channels: ["email", "sms", "in_app"],
  },
};

// The rows of 16.14 where the SMS depends on the data: the same message without an SMS.
export const WITHOUT_SMS: Partial<Record<TemplateId, Record<string, unknown>>> = {
  renewal_reminder: { ...SAMPLES.renewal_reminder.data, days: 7 },
  domain_renewal_reminder: { ...SAMPLES.domain_renewal_reminder.data, days: 30 },
};
