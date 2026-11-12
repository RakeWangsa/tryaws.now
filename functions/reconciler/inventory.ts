import type { AwsItem, LiveCount, UsageSample } from "@tc/core";
import type { PoolAccountRef } from "@tc/db";

// The read-only inventory PORT of the reconciler. The real implementation assumes TcReader (and, for
// zones and domains, TcDnsReader) in the pool account by STS AssumeRole, lists every Region and maps
// the answer to AwsItem and LiveCount. It is a manual VERIFY of WP7-T6 and is not built here; nothing in
// this folder calls AWS and no key exists (R3). The port has no write method: the reconciler cannot
// change AWS (R13).
//
// A read that is not complete is a failure, not a short list: one Region that could not be read makes
// the whole account `ok: false` (R16).

export type InventoryFailure =
  "unreachable" | "denied" | "throttled" | "incomplete" | "unconfigured";

export interface InventoryRead {
  readonly items: readonly AwsItem[];
  /** Live counts of the quota cells the port could count (certificate_365d has none). */
  readonly live: readonly LiveCount[];
  /**
   * WPU-B3: what AWS reports as used, for the metering run: snapshot GB of a server for today and the
   * data transfer GB of an hour (see UsageSample). Optional: a port that cannot measure leaves it out and
   * nothing is written (the metering run then charges nothing for what it cannot read, R16).
   */
  readonly usage?: readonly UsageSample[];
}

export type InventoryResult =
  | { readonly ok: true; readonly value: InventoryRead }
  | { readonly ok: false; readonly reason: InventoryFailure };

export interface InventoryPort {
  read(account: PoolAccountRef): Promise<InventoryResult>;
}

/** The default until the STS implementation exists: every account is reported as not read. */
export const unconfiguredInventory: InventoryPort = Object.freeze({
  async read(): Promise<InventoryResult> {
    return { ok: false, reason: "unconfigured" };
  },
});
