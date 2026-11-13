import type { Channel, TemplateId } from "../queue/types";
import { f, type Parsed, type Spec } from "./data";

// The 23 definitions: the closed list of fields each message accepts, the channels it uses (16.14),
// the panel path of its button and the variables its texts use. A definition holds no text: the
// texts are in messages.ts, so the data and the words can change apart.

export const PRODUCT_KEYS = [
  "instance",
  "database",
  "disk",
  "bucket",
  "load_balancer",
  "container_service",
  "cdn",
  "static_ip",
  "snapshot",
  "dns_zone",
  "domain",
] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

type Data = Readonly<Record<string, Parsed>>;

export interface Helpers {
  m(minor: Parsed | undefined): string;
  d(iso: Parsed | undefined): string;
  n(value: Parsed | undefined): string;
  product(key: Parsed | undefined): string;
  region(code: Parsed | undefined): string;
  // A named sentence of the template's `extra` catalog, filled with `vars`.
  x(key: string, vars?: Readonly<Record<string, string>>): string;
}

export interface TemplateDef {
  readonly spec: Spec;
  readonly channels: (data: Data) => readonly Channel[];
  readonly path: (data: Data) => string;
  readonly cta: string;
  readonly vars: (data: Data, h: Helpers) => Readonly<Record<string, string>>;
}

const s = (v: Parsed | undefined): string => String(v ?? "");

// 16.10 routes. A disk, a static IP and a backup live in the server pages, so they link to the list.
const ROOTS: Readonly<Record<ProductKey, string>> = {
  instance: "/servers",
  database: "/databases",
  disk: "/servers",
  bucket: "/storage",
  load_balancer: "/load-balancers",
  container_service: "/containers",
  cdn: "/cdn",
  static_ip: "/servers",
  snapshot: "/servers",
  dns_zone: "/dns",
  domain: "/domains",
};
const WITH_ID: ReadonlySet<ProductKey> = new Set([
  "instance",
  "database",
  "bucket",
  "load_balancer",
  "container_service",
  "cdn",
]);
export function productPath(product: string, resourceId: string): string {
  const key = product as ProductKey;
  if (!Object.hasOwn(ROOTS, key)) throw new TypeError("productPath: unknown product");
  return WITH_ID.has(key) ? `${ROOTS[key]}/${resourceId}` : ROOTS[key];
}

const ek: readonly Channel[] = ["email", "in_app"];
const esk: readonly Channel[] = ["email", "sms", "in_app"];
const fixed = (p: string) => () => p;
const resourcePath = (d: Data) => productPath(s(d.product), s(d.resourceId));
const name = (d: Data, h: Helpers) => (d.label === undefined ? h.product(d.product) : s(d.label));

const PRODUCT = f.oneOf(...PRODUCT_KEYS);
const resource = {
  resourceId: f.uuid,
  product: PRODUCT,
  label: f.opt(f.label),
};
const security: TemplateDef = {
  spec: { at: f.instant, ip: f.opt(f.ip) },
  channels: () => esk,
  path: fixed("/settings/security"),
  cta: "security",
  vars: (d, h) => ({
    time: h.d(d.at),
    where: d.ip === undefined ? "" : h.x("from_ip", { ip: s(d.ip) }),
  }),
};

// The longest reply an admin can send (MAX_REPLY of apps/admin/server/support-flow.ts).
const SUPPORT_REPLY_MAX = 5000;

// WPU-D4: the family a waitlist entry was made for (resources.family) as a product word, and the page
// where the customer orders it. An unknown family reads as the generic "Cloud Server" and links to the
// dashboard (the notice never names a family it cannot spell).
const FAMILY_PRODUCTS: Readonly<Record<string, ProductKey>> = {
  linux_instance: "instance",
  windows_instance: "instance",
  database: "database",
  disk: "disk",
  bucket: "bucket",
  load_balancer: "load_balancer",
  container_service: "container_service",
  cdn: "cdn",
  static_ip: "static_ip",
  dns_zone: "dns_zone",
  domain: "domain",
};
const FAMILY_PATHS: Readonly<Record<string, string>> = {
  linux_instance: "/servers/new",
  windows_instance: "/servers/new",
  database: "/databases",
  disk: "/servers",
  bucket: "/storage",
  load_balancer: "/load-balancers",
  container_service: "/containers",
  cdn: "/cdn",
  static_ip: "/servers",
  dns_zone: "/dns",
  domain: "/domains",
};

// Own keys only: "constructor" and "__proto__" are valid keys of the family field.
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export const DEFS: Readonly<Record<TemplateId, TemplateDef>> = {
  welcome: {
    spec: {},
    channels: () => ek,
    path: fixed("/dashboard"),
    cta: "open_panel",
    vars: () => ({}),
  },
  kyc_received: {
    spec: { submissionId: f.uuid },
    channels: () => ek,
    path: fixed("/kyc"),
    cta: "kyc",
    vars: () => ({}),
  },
  kyc_approved: {
    spec: { submissionId: f.uuid },
    channels: () => esk,
    path: fixed("/servers/new"),
    cta: "create_server",
    vars: () => ({}),
  },
  kyc_rejected: {
    spec: { submissionId: f.uuid, reason: f.text(300) },
    channels: () => ek,
    path: fixed("/kyc"),
    cta: "kyc",
    vars: (d) => ({ reason: s(d.reason) }),
  },
  topup_receipt: {
    spec: { paymentId: f.uuid, amountMinor: f.minor, balanceMinor: f.minor, creditedAt: f.instant },
    channels: () => ek,
    path: fixed("/wallet"),
    cta: "view_wallet",
    vars: (d, h) => ({
      amount: h.m(d.amountMinor),
      balance: h.m(d.balanceMinor),
      date: h.d(d.creditedAt),
    }),
  },
  order_paid: {
    spec: {
      orderId: f.uuid,
      invoiceId: f.uuid,
      invoiceNumber: f.invoiceNumber,
      product: PRODUCT,
      totalMinor: f.minor,
      balanceMinor: f.minor,
      paidAt: f.instant,
    },
    channels: () => ek,
    path: (d) => `/invoices/${s(d.invoiceId)}`,
    cta: "view_invoice",
    vars: (d, h) => ({
      invoice: s(d.invoiceNumber),
      product: h.product(d.product),
      total: h.m(d.totalMinor),
      balance: h.m(d.balanceMinor),
    }),
  },
  order_failed_refunded: {
    spec: {
      orderId: f.uuid,
      product: PRODUCT,
      failure: f.oneOf("create_failed", "capacity_full"),
      refundMinor: f.minor,
      balanceMinor: f.minor,
    },
    channels: () => ek,
    path: (d) => `/orders/${s(d.orderId)}`,
    cta: "view_order",
    vars: (d, h) => ({
      product: h.product(d.product),
      failure: h.x(s(d.failure)),
      refund: h.m(d.refundMinor),
      balance: h.m(d.balanceMinor),
    }),
  },
  // WPU-M3: a paid plan change could not be completed and the charge went back to the wallet.
  wallet_credited_plan_change: {
    spec: { transactionId: f.uuid, creditMinor: f.minor, balanceMinor: f.minor },
    channels: () => ek,
    path: fixed("/wallet"),
    cta: "view_wallet",
    vars: (d, h) => ({ credit: h.m(d.creditMinor), balance: h.m(d.balanceMinor) }),
  },
  resource_ready: {
    spec: { ...resource, regionCode: f.region, address: f.address },
    channels: () => esk,
    path: resourcePath,
    cta: "view_resource",
    vars: (d, h) => ({
      name: name(d, h),
      product: h.product(d.product),
      region: h.region(d.regionCode),
      address: s(d.address),
    }),
  },
  renewal_reminder: {
    spec: {
      subscriptionId: f.uuid,
      ...resource,
      days: f.oneOf(7, 3, 1),
      periodEnd: f.instant,
      amountMinor: f.minor,
      balanceMinor: f.minor,
      autoRenew: f.bool,
    },
    // SMS only at 1 day (16.14)
    channels: (d) => (d.days === 1 ? esk : ek),
    path: resourcePath,
    cta: "renew",
    vars: (d, h) => ({
      name: name(d, h),
      days: h.n(d.days),
      date: h.d(d.periodEnd),
      amount: h.m(d.amountMinor),
      balance: h.m(d.balanceMinor),
      note: h.x(d.autoRenew === true ? "auto_on" : "auto_off"),
    }),
  },
  renewed: {
    spec: {
      subscriptionId: f.uuid,
      resourceId: f.uuid,
      product: PRODUCT,
      invoiceId: f.uuid,
      invoiceNumber: f.invoiceNumber,
      totalMinor: f.minor,
      balanceMinor: f.minor,
      periodEnd: f.instant,
    },
    channels: () => ek,
    path: (d) => `/invoices/${s(d.invoiceId)}`,
    cta: "view_invoice",
    vars: (d, h) => ({
      invoice: s(d.invoiceNumber),
      total: h.m(d.totalMinor),
      balance: h.m(d.balanceMinor),
      date: h.d(d.periodEnd),
    }),
  },
  grace_started: {
    spec: {
      subscriptionId: f.uuid,
      ...resource,
      graceUntil: f.instant,
      amountMinor: f.minor,
      balanceMinor: f.minor,
    },
    channels: () => esk,
    path: resourcePath,
    cta: "renew",
    vars: (d, h) => ({
      name: name(d, h),
      until: h.d(d.graceUntil),
      amount: h.m(d.amountMinor),
      balance: h.m(d.balanceMinor),
    }),
  },
  resource_destroyed: {
    spec: {
      subscriptionId: f.uuid,
      ...resource,
      restoreUntil: f.instant,
      kept: f.oneOf("backup", "settings"),
    },
    channels: () => esk,
    path: resourcePath,
    cta: "restore",
    vars: (d, h) => ({ name: name(d, h), until: h.d(d.restoreUntil), kept: h.x(s(d.kept)) }),
  },
  backups_purged: {
    spec: {
      subscriptionId: f.uuid,
      ...resource,
      purgedAt: f.instant,
      kept: f.oneOf("backup", "settings"),
    },
    channels: () => ek,
    path: fixed("/dashboard"),
    cta: "open_panel",
    vars: (d, h) => ({ name: name(d, h), date: h.d(d.purgedAt), kept: h.x(s(d.kept)) }),
  },
  low_balance: {
    spec: { balanceMinor: f.minor, dueMinor: f.minor, windowDays: f.oneOf(1, 2, 3, 5, 7, 14, 30) },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({
      balance: h.m(d.balanceMinor),
      due: h.m(d.dueMinor),
      windowDays: h.n(d.windowDays),
    }),
  },
  payment_expired: {
    spec: { paymentId: f.uuid, amountMinor: f.minor },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({ amount: h.m(d.amountMinor) }),
  },
  security_new_sign_in: security,
  security_password_changed: security,
  security_totp_changed: security,
  security_email_changed: { ...security, path: fixed("/settings/profile") },
  security_phone_changed: { ...security, path: fixed("/settings/profile") },
  domain_contact_pending: {
    spec: { domain: f.domain },
    channels: () => ek,
    path: (d) => `/domains/${s(d.domain).toLowerCase()}`,
    cta: "open_domain",
    vars: (d) => ({ domain: s(d.domain).toLowerCase() }),
  },
  domain_renewal_reminder: {
    spec: { domain: f.domain, days: f.oneOf(60, 30, 7), expiresAt: f.instant },
    // SMS at 7 days only (16.14)
    channels: (d) => (d.days === 7 ? esk : ek),
    path: (d) => `/domains/${s(d.domain).toLowerCase()}`,
    cta: "open_domain",
    vars: (d, h) => ({
      domain: s(d.domain).toLowerCase(),
      days: h.n(d.days),
      date: h.d(d.expiresAt),
    }),
  },
  // WPU-D4: the text is written by an admin; the request id only keeps the row tied to its request.
  support_reply: {
    spec: { requestId: f.uuid, body: f.multiline(SUPPORT_REPLY_MAX) },
    // A visitor has no bell and no phone: the email is the whole message.
    channels: () => ["email"],
    path: fixed("/support"),
    cta: "open_support",
    vars: (d) => ({ message: s(d.body) }),
  },
  // WPU-D4 (spec 12): told on day 7 and day 12 after the zone was made; removed on day 14.
  dns_delegation_notice: {
    spec: { domain: f.domain, day: f.oneOf(7, 12), removeAt: f.instant },
    channels: () => ek,
    path: fixed("/dns"),
    cta: "open_dns",
    vars: (d, h) => ({
      domain: s(d.domain).toLowerCase(),
      days: h.n(d.day),
      date: h.d(d.removeAt),
    }),
  },
  // WPU-Y3 (DRAFT, owner approves the wording): a usage charge could not be paid. Day 0 of the rule.
  unpaid_warning: {
    spec: { ...resource },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({ name: name(d, h) }),
  },
  // WPU-Y3: from 1 day unpaid, once for each unpaid day: suspended, with the days left before deletion.
  unpaid_suspended: {
    spec: { ...resource, daysLeft: f.oneOf(1, 2, 3, 4, 5, 6), deleteAt: f.instant },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({ name: name(d, h), days: h.n(d.daysLeft), date: h.d(d.deleteAt) }),
  },
  // WPU-Y3: 7 days unpaid. `approval` is true while an admin must approve a deletion (R13).
  unpaid_deletion: {
    spec: { ...resource, deleteAt: f.instant, approval: f.bool },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({
      name: name(d, h),
      date: h.d(d.deleteAt),
      note: h.x(d.approval === true ? "approval" : "direct"),
    }),
  },
  // WPU-Y10 (DRAFT): after a late payment the final backup of the retention became an ordinary backup.
  unpaid_snapshot_released: {
    spec: { ...resource },
    channels: () => ek,
    path: resourcePath,
    cta: "view_resource",
    vars: (d, h) => ({ name: name(d, h) }),
  },
  // WPU-Y3: 3 days and 1 day before a renewal charge that the wallet cannot cover.
  wallet_low_before_charge: {
    spec: {
      ...resource,
      days: f.oneOf(3, 1),
      chargeDate: f.instant,
      amountMinor: f.minor,
      balanceMinor: f.minor,
    },
    channels: () => ek,
    path: fixed("/wallet/topup"),
    cta: "top_up",
    vars: (d, h) => ({
      name: name(d, h),
      date: h.d(d.chargeDate),
      amount: h.m(d.amountMinor),
      balance: h.m(d.balanceMinor),
    }),
  },
  waitlist_capacity_available: {
    spec: { productFamily: f.key, region: f.region },
    channels: () => ek,
    path: (d) => own(FAMILY_PATHS, s(d.productFamily)) ?? "/dashboard",
    cta: "order_now",
    vars: (d, h) => ({
      product: h.product(own(FAMILY_PRODUCTS, s(d.productFamily)) ?? "instance"),
      region: h.region(d.region),
    }),
  },
};
