import { LEASE_SECONDS, parseMessageBody, type QueueMessage } from "@tc/core";
import { runStep } from "./step";
import type { RunOutcome, StepDeps } from "./types";

// The three fields of the Lambda SQS event that this code reads, so no @types/aws-lambda is needed.
export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}
export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}
export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

type Run = (deps: StepDeps, message: QueueMessage) => Promise<RunOutcome>;

export function createHandler(
  deps: StepDeps,
  run: Run = runStep,
): (event: SqsEvent, context?: LambdaContext) => Promise<SqsBatchResponse> {
  // Fixed text only (R14): nothing of the body and nothing of an error reaches a log or a throw.
  const fail = (
    records: readonly SqsRecord[],
    index: number,
    reason: "malformed_body" | "run_error" | "lease",
  ): SqsBatchResponse => {
    const first = records[index];
    if (first === undefined) return { batchItemFailures: [] };
    if (reason !== "lease") {
      deps.log({ event: "batch_failure", messageId: first.messageId, reason });
    }
    // With batch size 1 a returned failure counts as a success unless ReportBatchItemFailures is on;
    // a throw is right either way, and no other record needs protecting.
    if (records.length === 1) throw new Error("provisioner: record failed");
    return {
      batchItemFailures: records.slice(index).map((r) => ({ itemIdentifier: r.messageId })),
    };
  };

  return async (event, context) => {
    const records = event.Records;
    if (context !== undefined && context.getRemainingTimeInMillis() > LEASE_SECONDS * 1000) {
      deps.log({ event: "lease_shorter_than_timeout" });
      return fail(records, 0, "lease");
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index] as SqsRecord;
      const message = parseMessageBody(record.body);
      if (message === null) return fail(records, index, "malformed_body");
      try {
        await run(deps, message);
      } catch {
        return fail(records, index, "run_error");
      }
    }
    return { batchItemFailures: [] };
  };
}
