// reader: the only code that reads live state, metrics and transfer of a customer's resource (R1).
// The web and admin tiers invoke it with { action, resourceId, caller, range? }; it assumes TcReader
// (read-only) in the pool account, after its own tenant check (3.2, 6.3).
// This file is the only place that touches the process: the environment, the clock and the log output.
//
// The tier of the invocation (alias "web" or "admin" of the invoked ARN) decides which caller kind is
// accepted: customerId only from web, adminId only from admin (WPU-S6). The infra grants each role
// the invoke permission on its own alias only.
//
// Not wired here (infra): the Lambda in the VPC with RDS Proxy, the invoke permission of the web and
// admin roles, and the TcReader assume-role permission of the execution role. `checkDomain` (TcDnsReader)
// is a later task.
import { withTx } from "@tc/db";
import { readConfig } from "./config";
import { buildReaderDeps } from "./deps";
import { readerTierOf, type ReaderOutput } from "./invoke";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event: unknown, tier: "web" | "admin" | null) => Promise<ReaderOutput>) | undefined;

// The tier comes from the alias in the invoked ARN of the Lambda context, never from the event (WPU-S6).
export const handler = async (
  event: unknown,
  context?: { readonly invokedFunctionArn?: string },
): Promise<ReaderOutput> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    inner = buildReaderDeps({
      config,
      clock: { now: () => new Date() },
      runTx: withTx,
      log: (e) => console.log(JSON.stringify(e)),
    }).handler;
  }
  return inner(event, readerTierOf(context?.invokedFunctionArn));
};
