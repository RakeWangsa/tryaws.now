// access-details: the only code that fetches a secret from AWS for a customer (R1, U9). The web tier
// invokes it with { action, resourceId, caller }; it assumes TcAccessDetails in the pool account after
// its own tenant check (3.2, 6.3). Today: the Windows password. The database password and the bucket
// access key (createBucketAccessKey of @tc/aws) are added by WP6-T2 and WP6-T4.
// This file is the only place that touches the process: the clock and the log output.
//
// Not wired here (infra): the Lambda in the VPC with RDS Proxy, the invoke permission of the web role,
// and the TcAccessDetails assume-role permission of the execution role.
import { withTx } from "@tc/db";
import { buildAccessDetails } from "./deps";
import type { WindowsPasswordResult } from "./handler";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event: unknown) => Promise<WindowsPasswordResult>) | undefined;

export const handler = async (event: unknown): Promise<WindowsPasswordResult> => {
  if (inner === undefined) {
    inner = buildAccessDetails({
      clock: { now: () => new Date() },
      runTx: withTx,
      log: (e) => console.log(JSON.stringify(e)),
    }).handler;
  }
  return inner(event);
};
