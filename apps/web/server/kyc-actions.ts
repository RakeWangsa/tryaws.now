import {
  KYC_MAX_FILE_BYTES,
  KYC_UPLOAD_TTL_SECONDS,
  kycObjectKey,
  parseKycStart,
  parseKycSubmit,
} from "@tc/core";
import type { KycCrypto, KycObjectStore, KycContentType } from "@tc/core";
import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, CustomerLimit, KycRepo, RateLimitsRepo } from "@tc/db";

// The cores of the two KYC actions (/kyc, WP2-T4). R9 order in each: authenticate, authorize (not
// verified, nothing pending), validate, rate limit, execute, audit. The ports are parameters, so the
// cores run in a test without a database or AWS. A document number is sealed by the crypto port
// before it is stored, and it is in no log, no audit entry and no returned value (R14). The object
// keys are made here from ids (R11); the browser never names one.

export interface KycRepos {
  kyc: KycRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
}

export interface KycPorts {
  objects: KycObjectStore;
  crypto: KycCrypto;
}

export interface KycActionDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** A new UUID v7 for a submission. */
  newId(): string;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: KycRepos) => Promise<T>): Promise<T>;
  /** null = not configured: the actions refuse (R16). */
  ports: KycPorts | null;
}

export type KycError =
  | "unauthenticated"
  | "forbidden"
  | "kyc_verified"
  | "kyc_pending"
  | "validation"
  | "rate_limited"
  | "upload_missing"
  | "conflict"
  | "unavailable";

export type StartKycResult =
  | {
      ok: true;
      submissionId: string;
      uploads: { url: string; fields: Record<string, string> }[];
    }
  | { ok: false; error: KycError; fields?: Record<string, string> };

export type SubmitKycResult =
  | { ok: true; status: "pending"; replayed: boolean }
  | { ok: false; error: KycError; fields?: Record<string, string> };

const KYC_LIMITS: readonly CustomerLimit[] = Object.freeze([
  Object.freeze({ action: "kyc.write", limit: 10, windowSeconds: 3600 }),
]);

/** The statuses that stop a new submission, as the screen's own error keys. */
function statusError(session: CustomerSession): KycError | null {
  if (session.kycStatus === "verified") return "kyc_verified";
  if (session.kycStatus === "pending") return "kyc_pending";
  return null;
}

export async function startKycUploadCore(
  deps: KycActionDeps,
  raw: unknown,
): Promise<StartKycResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const blocked = statusError(session);
  if (blocked !== null) return { ok: false, error: blocked };

  const parsed = parseKycStart(raw);
  if (!parsed.ok) return { ok: false, error: "validation", fields: parsed.fields };
  if (deps.ports === null) return { ok: false, error: "unavailable" };
  const { objects } = deps.ports;

  const submissionId = deps.newId();
  try {
    const allowed = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(KYC_LIMITS, deps.now());
      if (!limit.allowed) return false;
      const audited = await repos.audit.record({
        action: "kyc.upload_started",
        targetType: "kyc_submission",
        targetId: submissionId,
      });
      if (!audited.ok) throw new Error("kyc: the audit entry was refused");
      return true;
    });
    if (!allowed) return { ok: false, error: "rate_limited" };

    const uploads: { url: string; fields: Record<string, string> }[] = [];
    for (const [index, file] of parsed.value.files.entries()) {
      const presigned = await objects.presignUpload({
        key: kycObjectKey(session.customerId, submissionId, index, file.contentType),
        contentType: file.contentType,
        maxBytes: KYC_MAX_FILE_BYTES,
        expiresSeconds: KYC_UPLOAD_TTL_SECONDS,
      });
      uploads.push({ url: presigned.url, fields: { ...presigned.fields } });
    }
    return { ok: true, submissionId, uploads };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function submitKycCore(deps: KycActionDeps, raw: unknown): Promise<SubmitKycResult> {
  const session = await deps.authenticate();
  if (session === null) return { ok: false, error: "unauthenticated" };
  const blocked = statusError(session);
  if (blocked !== null) return { ok: false, error: blocked };

  const parsed = parseKycSubmit(raw);
  if (!parsed.ok) return { ok: false, error: "validation", fields: parsed.fields };
  if (deps.ports === null) return { ok: false, error: "unavailable" };
  const { objects, crypto } = deps.ports;
  const input = parsed.value;

  try {
    const allowed = await deps.store(session.customerId, async (repos) => {
      const limit = await repos.rateLimits.consume(KYC_LIMITS, deps.now());
      return limit.allowed;
    });
    if (!allowed) return { ok: false, error: "rate_limited" };

    // The keys come from the session and the ids; every file must be there, in the type it was
    // signed for and inside the size limit. Only the size and type are read, never the content.
    const keys: string[] = [];
    for (const [index, type] of input.fileTypes.entries()) {
      const key = kycObjectKey(
        session.customerId,
        input.submissionId,
        index,
        type as KycContentType,
      );
      const head = await objects.head(key);
      if (
        head === null ||
        head.contentType !== type ||
        head.size < 1 ||
        head.size > KYC_MAX_FILE_BYTES
      ) {
        return { ok: false, error: "upload_missing", fields: { files: "invalid" } };
      }
      keys.push(key);
    }
    const sealed = await crypto.seal(input.documentNumber);

    return await deps.store(session.customerId, async (repos): Promise<SubmitKycResult> => {
      const typed = await repos.kyc.setType(input.customerType);
      if (!typed.ok) return { ok: false, error: "unavailable" };
      const saved = await repos.kyc.submit({
        id: input.submissionId,
        documentType: input.documentType,
        documentNumberEncrypted: sealed,
        s3Keys: keys,
      });
      if (!saved.ok) {
        return { ok: false, error: saved.error === "conflict" ? "conflict" : "unavailable" };
      }
      // A replay changed nothing, so it audits nothing. The entry holds the id and the type only.
      if (!saved.replayed) {
        const audited = await repos.audit.record({
          action: "kyc.submitted",
          targetType: "kyc_submission",
          targetId: saved.value.id,
          metadata: { documentType: input.documentType },
        });
        if (!audited.ok) throw new Error("kyc: the audit entry was refused");
      }
      return { ok: true, status: "pending", replayed: saved.replayed };
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
