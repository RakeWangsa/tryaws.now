// kyc-check (WPU-Y3): the only place that touches the process (the environment, the S3 client, console).
// The logic is in handler.ts, the one S3 call in s3.ts.
import { readConfig } from "./config";
import { createKycCheckHandler, kycCheckTierOf, type KycCheckOutput } from "./handler";
import { createS3Client, createS3Head } from "./s3";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ReturnType<typeof createKycCheckHandler> | undefined;

// The tier comes from the alias in the invoked ARN of the Lambda context, never from the event.
export const handler = async (
  event: unknown,
  context?: { readonly invokedFunctionArn?: string },
): Promise<KycCheckOutput> => {
  if (inner === undefined) {
    const config = readConfig(process.env);
    inner = createKycCheckHandler({
      head: createS3Head({ client: createS3Client(), bucket: config.bucket }),
      log: (e) => console.log(JSON.stringify(e)),
    });
  }
  return inner(event, kycCheckTierOf(context?.invokedFunctionArn));
};
