export interface KycCheckConfig {
  /** The kyc bucket of the stage (infra/stacks/workers.ts sets KYC_BUCKET for this function only). */
  readonly bucket: string;
}

// An S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens, starting and ending with a
// letter or digit.
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Fail closed (R16): the message names the variable and never its value (R3, R14).
export function readConfig(env: Record<string, string | undefined>): KycCheckConfig {
  const bucket = env["KYC_BUCKET"];
  if (bucket === undefined || !BUCKET.test(bucket)) {
    throw new Error("kyc-check: KYC_BUCKET is missing or invalid");
  }
  return { bucket };
}
