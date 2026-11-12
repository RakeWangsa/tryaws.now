import type { NotifyInput } from "./notify";

// WPU-D4: the notice that @tc/core builds for one taken waitlist entry (WaitlistNotice) as the input of
// notify(). Structural on purpose: @tc/notify does not import the capacity code. A customer entry is
// reached through the customer row (the notifier reads the address there), a visitor entry through the
// address that the entry holds; the one that is null is left out, so planRows sees exactly one of them.
export interface WaitlistNoticeLike {
  readonly customerId: string | null;
  readonly email: string | null;
  readonly template: "waitlist_capacity_available";
  readonly dedupeKey: string;
  readonly data: { readonly productFamily: string; readonly region: string };
}

export function waitlistNoticeToInput(notice: WaitlistNoticeLike): NotifyInput {
  return {
    ...(notice.customerId === null ? {} : { customerId: notice.customerId }),
    ...(notice.customerId === null && notice.email !== null ? { email: notice.email } : {}),
    template: notice.template,
    data: { productFamily: notice.data.productFamily, region: notice.data.region },
    dedupeKey: notice.dedupeKey,
  };
}
