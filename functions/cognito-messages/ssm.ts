import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { ReadParameters } from "./config";

// The SSM read of config.ts: one GetParameters call for both names, String parameters (no decryption).
// The client is made on the first read (the region and credentials of the Lambda), never at import.
// The function's role may read exactly these two parameter ARNs (infra/stacks/auth.ts).
export function ssmReadParameters(make: () => SSMClient = () => new SSMClient({})): ReadParameters {
  let client: SSMClient | undefined;
  return async (names) => {
    client ??= make();
    const answer = await client.send(new GetParametersCommand({ Names: [...names] }));
    const values: Record<string, string> = {};
    for (const p of answer.Parameters ?? []) {
      if (typeof p.Name === "string" && typeof p.Value === "string") values[p.Name] = p.Value;
    }
    return values;
  };
}
