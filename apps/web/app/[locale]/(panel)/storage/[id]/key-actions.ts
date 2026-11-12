"use server";

import { getAccessPort } from "../../../../../server/access-port.ts";
import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import { bucketKeysDeps } from "../../../../../server/bucket-deps.ts";
import { createBucketKeyCore } from "../../../../../server/bucket-keys.ts";
import type { KeyResult } from "./BucketKeys.tsx";

// R9 in this order: the origin, then the core (authenticate, fresh sign-in, own bucket and typed name,
// validate, rate limit, execute). The audit row is written by the access-details function. The answer
// holds the secret key and is returned to the browser once: nothing here logs or keeps it (U9, R14).
// The transport is the invoke port of access-details (WPU-N2); with none configured the core refuses (R16).
export async function createBucketKeyAction(form: FormData): Promise<KeyResult> {
  if (!(await guardAction())) return { ok: false, error: "unauthenticated" };
  const result = await createBucketKeyCore(
    bucketKeysDeps(await getAccessPort()),
    pick(form, ["bucketId", "requestId", "confirmName"]),
  );
  return result.ok
    ? { ok: true, accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey }
    : { ok: false, error: result.error };
}
