import type { LightsailClient } from "@aws-sdk/client-lightsail";
import type { STSClient } from "@aws-sdk/client-sts";
import type { ErrorCode } from "@tc/core";

export type LocalReason =
  "role_not_allowed" | "region_not_allowed" | "account_ref_invalid" | "sts_response_invalid";

export interface AwsErrorInit {
  code: ErrorCode;
  retryable: boolean;
  poolFull?: boolean;
  awsErrorName?: string | null;
  reason?: LocalReason | null;
  operation?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
}

/**
 * The one error of this package. It carries a platform code and two flags, never AWS text:
 * no message of AWS, no `cause`, no reference to the original error (16.13, R14).
 */
export class AwsError extends Error {
  readonly name = "AwsError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly poolFull: boolean;
  readonly awsErrorName: string | null;
  readonly reason: LocalReason | null;
  readonly operation: string | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;

  constructor(init: AwsErrorInit) {
    const awsErrorName = init.awsErrorName ?? null;
    const reason = init.reason ?? null;
    const operation = init.operation ?? null;
    super(
      `AWS ${operation ?? "call"} failed: ${init.code} (${awsErrorName ?? reason ?? "unknown"})`,
    );
    this.code = init.code;
    this.retryable = init.retryable;
    this.poolFull = init.poolFull ?? false;
    this.awsErrorName = awsErrorName;
    this.reason = reason;
    this.operation = operation;
    this.httpStatus = init.httpStatus ?? null;
    this.requestId = init.requestId ?? null;
  }
}

interface Facts {
  name: string | null;
  code: string | null;
  message: string | null;
  status: number | null;
  requestId: string | null;
}

interface Row {
  match(f: Facts): boolean;
  code: ErrorCode;
  retryable: boolean;
  poolFull: boolean;
}

const names = (...list: string[]) => {
  const set = new Set(list);
  return (n: string | null) => n !== null && set.has(n);
};

const isQuotaName = names("ServiceQuotaExceededException", "QuotaExceededException");
const isFaultName = names("InvalidInputException", "OperationFailureException", "ServiceException");
const isThrottleName = names(
  "ThrottlingException",
  "Throttling",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "ThrottledException",
  "RequestThrottled",
  "RequestThrottledException",
  "SlowDown",
  "PriorRequestNotComplete",
  "BandwidthLimitExceeded",
  "EC2ThrottledException",
  "LimitExceededException",
  "ProvisionedThroughputExceededException",
  "TransactionInProgressException",
);
const isValidationName = names(
  "InvalidInputException",
  "ValidationError",
  "ValidationException",
  "MalformedHttpRequestException",
  "RequestEntityTooLargeException",
  "UnknownOperationException",
  "MalformedPolicyDocument",
  "MalformedPolicyDocumentException",
  "PackedPolicyTooLarge",
  "PackedPolicyTooLargeException",
);
const isNotFoundName = names("NotFoundException", "ResourceNotFoundException", "NoSuchEntity");
const isForbiddenName = names(
  "AccessDeniedException",
  "AccessDenied",
  "NotAuthorized",
  "UnauthorizedOperation",
  "OptInRequired",
  "RegionDisabledException",
);
const isUnauthenticatedName = names(
  "UnauthenticatedException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "IncompleteSignature",
  "SignatureDoesNotMatch",
  "InvalidSignatureException",
  "MissingAuthenticationToken",
  "ExpiredToken",
  "ExpiredTokenException",
  "RequestExpired",
  "SessionDurationEscalationException",
);
const isSetupName = names("AccountSetupInProgressException", "RegionSetupInProgressException");
const isServerName = names(
  "ServiceException",
  "InternalFailure",
  "InternalError",
  "InternalServerError",
  "InternalServerErrorException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "RequestTimeout",
  "RequestTimeoutException",
  "RequestAbortedException",
  "TimeoutError",
  "AbortError",
);
const isNetworkCode = names(
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
);

const QUOTA_MESSAGE =
  /maximum number of|quota|limit exceeded|exceeded (the|your) limit|reached the limit/i;
const IN_USE_MESSAGE = /already in use|already exists/i;

// The first matching row wins: the order of this array is the order of the table.
const ROWS: readonly Row[] = [
  {
    match: (f) =>
      isQuotaName(f.name) ||
      (isFaultName(f.name) && f.message !== null && QUOTA_MESSAGE.test(f.message)),
    code: "capacity_full",
    retryable: true,
    poolFull: true,
  },
  {
    match: (f) =>
      f.name === "InvalidInputException" && f.message !== null && IN_USE_MESSAGE.test(f.message),
    code: "conflict",
    retryable: true,
    poolFull: false,
  },
  {
    match: (f) => isThrottleName(f.name) || f.status === 429,
    code: "rate_limited",
    retryable: true,
    poolFull: false,
  },
  { match: (f) => isValidationName(f.name), code: "validation", retryable: false, poolFull: false },
  { match: (f) => isNotFoundName(f.name), code: "not_found", retryable: true, poolFull: false },
  {
    match: (f) => f.name === "OperationFailureException",
    code: "conflict",
    retryable: true,
    poolFull: false,
  },
  { match: (f) => isForbiddenName(f.name), code: "forbidden", retryable: true, poolFull: false },
  {
    match: (f) => isUnauthenticatedName(f.name),
    code: "unauthenticated",
    retryable: true,
    poolFull: false,
  },
  {
    match: (f) => isSetupName(f.name),
    code: "upstream_unavailable",
    retryable: true,
    poolFull: false,
  },
  {
    match: (f) => isServerName(f.name) || (f.status !== null && f.status >= 500 && f.status <= 599),
    code: "upstream_unavailable",
    retryable: true,
    poolFull: false,
  },
  {
    match: (f) => isNetworkCode(f.code),
    code: "upstream_unavailable",
    retryable: true,
    poolFull: false,
  },
];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readFacts(error: unknown): Facts {
  if (typeof error !== "object" || error === null) {
    return { name: null, code: null, message: null, status: null, requestId: null };
  }
  const e = error as Record<string, unknown>;
  const meta = e["$metadata"];
  const m = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  const status = m["httpStatusCode"];
  return {
    name: str(e["name"]),
    code: str(e["code"]),
    message: str(e["message"]),
    status: typeof status === "number" && Number.isFinite(status) ? status : null,
    requestId: str(m["requestId"]),
  };
}

function safeName(value: string | null): string {
  return value !== null && IDENTIFIER.test(value) ? value : "Unknown";
}

const NETWORK_ROW = ROWS.length - 1;

function classify(error: unknown, operation: string | null): AwsError {
  const f = readFacts(error);
  const index = ROWS.findIndex((r) => r.match(f));
  const row = ROWS[index];
  return new AwsError({
    code: row?.code ?? "internal",
    retryable: row?.retryable ?? true,
    poolFull: row?.poolFull ?? false,
    // Row 11 is the only row that names the error by its network code.
    awsErrorName: safeName(index === NETWORK_ROW ? f.code : f.name),
    operation,
    httpStatus: f.status,
    requestId: f.requestId,
  });
}

/**
 * Turns anything that a failed AWS call can throw into an `AwsError`. The raw message is read
 * only to classify (rows 1 and 2) and is dropped. Never throws: a value whose properties cannot
 * be read gives row 12.
 */
export function toAwsError(error: unknown, operation: string | null): AwsError {
  try {
    if (error instanceof AwsError) return error;
    return classify(error, operation);
  } catch {
    return new AwsError({
      code: "internal",
      retryable: true,
      awsErrorName: "Unknown",
      operation,
    });
  }
}

export interface AwsLogFields {
  errorCode: ErrorCode;
  awsErrorName: string | null;
  reason: LocalReason | null;
  operation: string | null;
  retryable: boolean;
  poolFull: boolean;
  httpStatus: number | null;
  requestId: string | null;
}

/** The fields a caller logs for an `AwsError` (R14). This package writes no log line itself. */
export function toLogFields(error: AwsError): AwsLogFields {
  return {
    errorCode: error.code,
    awsErrorName: error.awsErrorName,
    reason: error.reason,
    operation: error.operation,
    retryable: error.retryable,
    poolFull: error.poolFull,
    httpStatus: error.httpStatus,
    requestId: error.requestId,
  };
}

export function mapErrors(client: LightsailClient): void;
export function mapErrors(client: STSClient): void;
export function mapErrors(client: LightsailClient | STSClient): void {
  // The two clients have middleware stacks of different types: one cast, then one `add`.
  (client.middlewareStack as unknown as LightsailClient["middlewareStack"]).add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        const operation = context.commandName?.replace(/Command$/, "") ?? null;
        throw toAwsError(error, operation);
      }
    },
    { step: "initialize", name: "tcErrorMapping", priority: "high" },
  );
}
