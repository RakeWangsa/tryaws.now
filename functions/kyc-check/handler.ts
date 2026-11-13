import { kycKeyOwnedBy } from "@tc/core";

// WPU-Y3. kyc-check tells the web tier whether one KYC upload arrived: its size and content type, never its
// content. The web role may not read the kyc bucket (infra/stacks/storage.ts denies it GetObject,
// GetObjectVersion and ListBucket, the "read only by admin" proof), and S3 HeadObject needs s3:GetObject;
// so the web server invokes this function instead of asking S3 (R1: no packages/aws in apps/).
//
// The event is `{ action: "head", key, caller: { customerId } }`. The web server derives the key from the
// session's customer (kycObjectKey); this function checks again that the key is exactly a KYC key of that
// customer before it asks S3 (R8). The order of R9: authenticate (the tier and the caller), authorize (the
// key belongs to the caller), validate, execute. The web action rate-limits kyc.write before it calls; the
// check writes nothing, so there is nothing to audit here.

export interface Logger {
  (event: Record<string, unknown>): void;
}

export type HeadResult =
  | { readonly present: false }
  | { readonly present: true; readonly size: number; readonly contentType: string };

export interface KycCheckDeps {
  /** One S3 HeadObject in the kyc bucket (s3.ts). Throws when it cannot complete. */
  readonly head: (key: string) => Promise<HeadResult>;
  readonly log: Logger;
}

export type KycCheckError = "unauthenticated" | "validation" | "forbidden" | "upstream_unavailable";

export interface KycObjectFacts {
  readonly present: boolean;
  readonly size: number | null;
  readonly contentType: string | null;
}

export type KycCheckOutput =
  | { readonly ok: true; readonly value: KycObjectFacts }
  | { readonly ok: false; readonly error: KycCheckError };

// The function has one alias, "web" (infra/stacks/workers.ts). The infra grants the web role
// lambda:InvokeFunction on that alias ARN and on nothing else, and Lambda puts the alias into
// context.invokedFunctionArn, which the caller of the event cannot choose. Anything but exactly that alias
// is no tier and is refused before the event is read (R16).
export type KycCheckTier = "web";

export function kycCheckTierOf(invokedFunctionArn: unknown): KycCheckTier | null {
  if (typeof invokedFunctionArn !== "string") return null;
  const parts = invokedFunctionArn.split(":");
  if (
    parts.length !== 8 ||
    parts[0] !== "arn" ||
    parts[2] !== "lambda" ||
    parts[5] !== "function"
  ) {
    return null;
  }
  return parts[7] === "web" ? "web" : null;
}

const MAX_TYPE_LENGTH = 255;

/** Exactly one customer id, nothing beside it; else null. */
function customerOf(caller: unknown): string | null {
  if (typeof caller !== "object" || caller === null) return null;
  const keys = Object.keys(caller);
  if (keys.length !== 1 || keys[0] !== "customerId") return null;
  const id = (caller as { customerId?: unknown }).customerId;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

/** An answer of S3 that is not the documented shape is not trusted (R16). */
function trusted(answer: HeadResult): KycObjectFacts | null {
  if (typeof answer !== "object" || answer === null) return null;
  if (answer.present === false) return { present: false, size: null, contentType: null };
  if (answer.present !== true) return null;
  const { size, contentType } = answer as { size: unknown; contentType: unknown };
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof contentType !== "string" || contentType.length > MAX_TYPE_LENGTH) return null;
  return { present: true, size, contentType };
}

export function createKycCheckHandler(
  deps: KycCheckDeps,
): (event: unknown, tier: KycCheckTier | null) => Promise<KycCheckOutput> {
  // Fixed words only: no key, no customer id, no AWS text (R14).
  const done = (outcome: string, output: KycCheckOutput): KycCheckOutput => {
    deps.log({ event: "kyc_check", outcome });
    return output;
  };
  const refuse = (error: KycCheckError) => done(error, { ok: false, error });

  return async (event, tier) => {
    if (tier !== "web") return refuse("unauthenticated");
    if (typeof event !== "object" || event === null) return refuse("validation");
    const e = event as Record<string, unknown>;
    if (e["action"] !== "head") return refuse("validation");
    const customerId = customerOf(e["caller"]);
    if (customerId === null) return refuse("unauthenticated");
    const key = e["key"];
    if (typeof key !== "string") return refuse("validation");
    // R8: a key of another customer, or anything that is not a KYC key of this one, is refused before S3.
    if (!kycKeyOwnedBy(key, customerId)) return refuse("forbidden");

    let facts: KycObjectFacts | null;
    try {
      facts = trusted(await deps.head(key));
    } catch {
      return refuse("upstream_unavailable");
    }
    if (facts === null) return refuse("upstream_unavailable");
    return done(facts.present ? "present" : "absent", { ok: true, value: facts });
  };
}
