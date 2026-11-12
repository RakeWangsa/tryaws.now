// access-details: the only code that fetches a secret from AWS for a customer (R1, U9). The web tier
// invokes it with { action, resourceId, caller, requestId? } on its "web" alias; it assumes
// TcAccessDetails in the pool account after its own tenant check (3.2, 6.3). Actions: the Windows
// password, the database master password, a bucket access key (create) and the list of a bucket's keys.
// Deleting a key is not a secret and stays an operation of the provisioner (apps/web bucket-actions).
// This file is the only place that touches the process: the clock and the log output.
//
// The tier of the invocation (alias "web" or "admin" of the invoked ARN) decides who may ask:
// customerId only from "web" (WPU-N2, the rule of the reader). The infra grants the web role the web
// alias only and the admin role nothing.
//
// Not wired here (infra): the Lambda in the VPC with RDS Proxy, the invoke permission of the web role
// and the TcAccessDetails assume-role permission of the execution role.
import { withTx } from "@tc/db";
import { buildAccessDetails } from "./deps";
import { accessTierOf, type AccessOutput } from "./invoke";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event: unknown, tier: "web" | "admin" | null) => Promise<AccessOutput>) | undefined;

// The tier comes from the alias in the invoked ARN of the Lambda context, never from the event.
export const handler = async (
  event: unknown,
  context?: { readonly invokedFunctionArn?: string },
): Promise<AccessOutput> => {
  if (inner === undefined) {
    inner = buildAccessDetails({
      clock: { now: () => new Date() },
      runTx: withTx,
      log: (e) => console.log(JSON.stringify(e)),
    }).handler;
  }
  return inner(event, accessTierOf(context?.invokedFunctionArn));
};
