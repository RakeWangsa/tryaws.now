import type { Tx } from "@tc/db";

// WPU-Y3. The four customer messages of the unpaid-usage rule and of the low-wallet reminder. They are
// templates of @tc/notify (TEMPLATE_IDS), which core cannot import (notify depends on core), so the
// caller injects the writer: the scheduler passes `notify` of @tc/notify. A test in @tc/notify keeps
// this list inside TEMPLATE_IDS. Wording approved by the owner on 2026-11-13: the texts are in packages/notify/templates/messages.ts.
export const UNPAID_TEMPLATES = [
  "unpaid_warning",
  "unpaid_suspended",
  "unpaid_deletion",
  "unpaid_snapshot_released",
  "wallet_low_before_charge",
] as const;
export type UnpaidTemplateId = (typeof UNPAID_TEMPLATES)[number];

export interface Notice {
  readonly customerId: string;
  readonly template: UnpaidTemplateId;
  readonly data: Record<string, unknown>;
  /** A caller key (letters, digits, `.:_-`); the queue adds the template and the channel. R7. */
  readonly dedupeKey: string;
}
export type NoticeWriter = (tx: Tx, notice: Notice) => Promise<void>;

// resources.family -> the product word of the templates. A family that is not here gets no message
// (the job logs it) rather than a wrong word.
const PRODUCTS: Readonly<Record<string, string>> = Object.freeze({
  linux_instance: "instance",
  windows_instance: "instance",
  database: "database",
  disk: "disk",
});
export function productOfFamily(family: string): string | null {
  return Object.hasOwn(PRODUCTS, family) ? (PRODUCTS[family] as string) : null;
}
