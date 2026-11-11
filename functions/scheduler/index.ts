import { sweepOperations, type Logger, type SweepDeps, type SweepReport } from "@tc/core";

// The lifecycle part of the scheduler (WP5-T4) is added to this handler later.
export function createHandler(deps: SweepDeps & { log: Logger }): () => Promise<SweepReport> {
  return async () => {
    const report = await sweepOperations(deps);
    deps.log({ event: "sweep", ...report });
    return report;
  };
}
