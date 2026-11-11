// reader: the only code that reads live state, metrics and transfer of a customer's resource (R1).
// The web and admin tiers invoke it with { action, resourceId, caller, range? }; it assumes TcReader
// (read-only) in the pool account, after its own tenant check (3.2, 6.3).
// This file is the only place that touches the process: the environment, the clock and the log output.
//
// Not wired here (infra): the Lambda in the VPC with RDS Proxy, the invoke permission of the web and
// admin roles, and the TcReader assume-role permission of the execution role. `checkDomain` (TcDnsReader)
// is a later task.
import { withTx } from "@tc/db";
import { readConfig } from "./config";
import { buildReaderDeps } from "./deps";
import type { ReaderOutput } from "./invoke";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event: unknown) => Promise<ReaderOutput>) | undefined;

export const handler = async (event: unknown): Promise<ReaderOutput> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    inner = buildReaderDeps({
      config,
      clock: { now: () => new Date() },
      runTx: withTx,
      log: (e) => console.log(JSON.stringify(e)),
    }).handler;
  }
  return inner(event);
};
