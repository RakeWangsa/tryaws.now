// WP2-T4: the pure rules of the identity check (6.1, 7). No AWS, no HTTP, no database. A document
// number is data of the customer: it is validated here, sealed by a port and never logged (R14).

export const KYC_CUSTOMER_TYPES = ["individual", "business"] as const;
export type KycCustomerType = (typeof KYC_CUSTOMER_TYPES)[number];

export const KYC_DOCUMENT_TYPES = [
  "nid",
  "passport",
  "driving_license",
  "trade_license",
  "tin_certificate",
] as const;
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

const DOCUMENTS_BY_TYPE: Readonly<Record<KycCustomerType, readonly KycDocumentType[]>> = {
  individual: ["nid", "passport", "driving_license"],
  business: ["trade_license", "tin_certificate"],
};

export function documentTypesFor(type: KycCustomerType): readonly KycDocumentType[] {
  return DOCUMENTS_BY_TYPE[type];
}

export const KYC_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const KYC_MIN_FILES = 1;
export const KYC_MAX_FILES = 2;
export const KYC_UPLOAD_TTL_SECONDS = 600;
export const KYC_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export type KycContentType = (typeof KYC_CONTENT_TYPES)[number];

const EXTENSION: Readonly<Record<KycContentType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

// The status of the customer (customers.kyc_status) and of a submission (kyc_submissions.status).
export type KycStatus = "none" | "pending" | "verified" | "rejected";
export type KycEvent = "submit" | "approve" | "reject";

const TRANSITIONS: Readonly<Record<KycStatus, Partial<Record<KycEvent, KycStatus>>>> = {
  none: { submit: "pending" },
  pending: { approve: "verified", reject: "rejected" },
  rejected: { submit: "pending" },
  // Final: a correction of a verified customer is an admin decision outside this machine.
  verified: {},
};

/** The next status, or null when the event is not allowed in the current status (fail closed, R16). */
export function nextKycStatus(current: KycStatus, event: KycEvent): KycStatus | null {
  return TRANSITIONS[current]?.[event] ?? null;
}

/** One open submission per customer, and none once verified. */
export function canSubmitKyc(status: KycStatus, hasOpenSubmission: boolean): boolean {
  return !hasOpenSubmission && nextKycStatus(status, "submit") !== null;
}

export interface KycFileMeta {
  readonly contentType: KycContentType;
  readonly size: number;
}

export interface KycStartInput {
  readonly customerType: KycCustomerType;
  readonly documentType: KycDocumentType;
  readonly files: readonly KycFileMeta[];
}

export type KycParsed<T> = { ok: true; value: T } | { ok: false; fields: Record<string, string> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseTypes(
  record: Record<string, unknown>,
  fields: Record<string, string>,
): { customerType: KycCustomerType; documentType: KycDocumentType } | null {
  const customerType = (KYC_CUSTOMER_TYPES as readonly unknown[]).includes(record["customerType"])
    ? (record["customerType"] as KycCustomerType)
    : null;
  if (customerType === null) fields["customerType"] = "invalid";
  const documentType =
    customerType !== null &&
    (documentTypesFor(customerType) as readonly unknown[]).includes(record["documentType"])
      ? (record["documentType"] as KycDocumentType)
      : null;
  if (documentType === null) fields["documentType"] = "invalid";
  return customerType !== null && documentType !== null ? { customerType, documentType } : null;
}

export function parseFileMeta(raw: unknown): KycFileMeta | null {
  if (!isRecord(raw)) return null;
  const { contentType, size } = raw;
  if (!(KYC_CONTENT_TYPES as readonly unknown[]).includes(contentType)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return null;
  if (size > KYC_MAX_FILE_BYTES) return null;
  return { contentType: contentType as KycContentType, size };
}

function parseFiles(raw: unknown, fields: Record<string, string>): KycFileMeta[] | null {
  if (!Array.isArray(raw) || raw.length < KYC_MIN_FILES || raw.length > KYC_MAX_FILES) {
    fields["files"] = "invalid";
    return null;
  }
  const files: KycFileMeta[] = [];
  for (const item of raw) {
    const meta = parseFileMeta(item);
    if (meta === null) {
      fields["files"] = "invalid";
      return null;
    }
    files.push(meta);
  }
  return files;
}

/** The input of startKycUpload: types and the metadata of the files (the browser checks the same limits). */
export function parseKycStart(raw: unknown): KycParsed<KycStartInput> {
  const record = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const types = parseTypes(record, fields);
  const files = parseFiles(record["files"], fields);
  if (types === null || files === null) return { ok: false, fields };
  return { ok: true, value: { ...types, files } };
}

const NUMBER_SHAPE: Readonly<Record<KycDocumentType, RegExp>> = {
  nid: /^(?:[0-9]{10}|[0-9]{13}|[0-9]{17})$/,
  passport: /^[A-Z0-9]{6,9}$/,
  driving_license: /^[A-Z0-9/-]{8,20}$/,
  trade_license: /^[A-Z0-9/-]{4,32}$/,
  tin_certificate: /^[0-9]{12}$/,
};

/** Upper case, no spaces; null when the shape of the document type does not match. */
export function normalizeDocumentNumber(type: KycDocumentType, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const value = raw.replace(/\s/g, "").toUpperCase();
  return NUMBER_SHAPE[type].test(value) ? value : null;
}

export interface KycSubmitInput {
  readonly submissionId: string;
  readonly customerType: KycCustomerType;
  readonly documentType: KycDocumentType;
  readonly documentNumber: string;
  /** The content type of each uploaded file, in upload order; the keys are derived, never sent. */
  readonly fileTypes: readonly KycContentType[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseKycSubmit(raw: unknown): KycParsed<KycSubmitInput> {
  const record = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const submissionId = record["submissionId"];
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    fields["submissionId"] = "invalid";
  }
  const types = parseTypes(record, fields);
  const documentNumber =
    types === null ? null : normalizeDocumentNumber(types.documentType, record["documentNumber"]);
  if (types !== null && documentNumber === null) fields["documentNumber"] = "invalid";
  const rawTypes = record["fileTypes"];
  const fileTypes =
    Array.isArray(rawTypes) &&
    rawTypes.length >= KYC_MIN_FILES &&
    rawTypes.length <= KYC_MAX_FILES &&
    rawTypes.every((t) => (KYC_CONTENT_TYPES as readonly unknown[]).includes(t))
      ? (rawTypes as KycContentType[])
      : null;
  if (fileTypes === null) fields["files"] = "invalid";
  if (
    Object.keys(fields).length > 0 ||
    types === null ||
    documentNumber === null ||
    fileTypes === null ||
    typeof submissionId !== "string"
  ) {
    return { ok: false, fields };
  }
  return { ok: true, value: { submissionId, ...types, documentNumber, fileTypes } };
}

/** The object key of one file. Made from ids and a counter only: customer text never enters it (R11). */
export function kycObjectKey(
  customerId: string,
  submissionId: string,
  index: number,
  contentType: KycContentType,
): string {
  if (!UUID.test(customerId) || !UUID.test(submissionId)) {
    throw new TypeError("kycObjectKey: ids must be UUIDs");
  }
  if (!Number.isInteger(index) || index < 0 || index >= KYC_MAX_FILES) {
    throw new RangeError("kycObjectKey: index out of range");
  }
  return `kyc/${customerId}/${submissionId}/${index}.${EXTENSION[contentType]}`;
}

/** A document number as it may appear in a log or an audit entry: never the number (R14). */
export function redactDocumentNumber(): string {
  return "[redacted]";
}
