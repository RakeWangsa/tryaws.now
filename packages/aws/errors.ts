import type { LightsailClient } from "@aws-sdk/client-lightsail";
import type { Route53Client } from "@aws-sdk/client-route-53";
import type { STSClient } from "@aws-sdk/client-sts";
import type { ErrorCode } from "@tc/core";

export type LocalReason =
  | "role_not_allowed"
  | "region_not_allowed"
  | "account_ref_invalid"
  | "sts_response_invalid"
  | "catalog_response_invalid"
  | "catalog_pages_exceeded"
  | "usage_response_invalid"
  | "usage_pages_exceeded"
  | "not_configured";

const LOCAL_REASONS: readonly string[] = [
  "role_not_allowed",
  "region_not_allowed",
  "account_ref_invalid",
  "sts_response_invalid",
  "catalog_response_invalid",
  "catalog_pages_exceeded",
  "usage_response_invalid",
  "usage_pages_exceeded",
  "not_configured",
];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const OPERATION_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
// Only these Node network codes are kept; any other text (an id, a key) becomes null.
const NODE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const ACCOUNT_ID_IN_NAME = /\d{12}/;
const REQUEST_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;

export interface AwsErrorInit {
  code: ErrorCode;
  retryable: boolean;
  poolFull?: boolean;
  awsErrorName?: string | null;
  reason?: LocalReason | null;
  operation?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
  /** True when AWS may already have acted on the request. Local errors leave it false. */
  mayHaveActed?: boolean;
  /** The Node error code (ECONNRESET and the like), which the SDK's `TimeoutError` hides. */
  nodeCode?: string | null;
}

function plainName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && IDENTIFIER.test(value) && !ACCOUNT_ID_IN_NAME.test(value)
    ? value
    : "Unknown";
}

function plainStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/**
 * The one error of this package. It carries a platform code and flags, never AWS text:
 * no message of AWS, no `cause`, no reference to the original error (16.13, R14). The constructor
 * keeps every text field only in its plain form and the object is frozen.
 *
 * `retryable: true` never means "safe to send again without looking first": when `mayHaveActed`
 * is true, AWS may already have done what the call asked.
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
  readonly mayHaveActed: boolean;
  readonly nodeCode: string | null;

  constructor(init: AwsErrorInit) {
    const awsErrorName = plainName(init.awsErrorName);
    const reason =
      typeof init.reason === "string" && LOCAL_REASONS.includes(init.reason) ? init.reason : null;
    const operation =
      typeof init.operation === "string" && OPERATION_NAME.test(init.operation)
        ? init.operation
        : null;
    super(
      `AWS ${operation ?? "call"} failed: ${init.code} (${awsErrorName ?? reason ?? "unknown"})`,
    );
    this.code = init.code;
    this.retryable = init.retryable;
    this.poolFull = init.poolFull ?? false;
    this.awsErrorName = awsErrorName;
    this.reason = reason;
    this.operation = operation;
    this.httpStatus = plainStatus(init.httpStatus);
    this.requestId = plainRequestId(init.requestId);
    this.mayHaveActed = init.mayHaveActed === true;
    this.nodeCode =
      typeof init.nodeCode === "string" && NODE_CODES.has(init.nodeCode) ? init.nodeCode : null;
    Object.freeze(this);
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
// InvalidInputException is not here: it is Lightsail's generic 400 and also carries quota,
// duplicate-name and state conflicts, so it is validation but never final (the row after).
const isValidationName = names(
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
  {
    match: (f) => f.name === "InvalidInputException",
    code: "validation",
    retryable: true,
    poolFull: false,
  },
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

// A request id is a response header: any text can arrive there, so only its plain form is kept.
function plainRequestId(value: unknown): string | null {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

const COMMAND_SUFFIX = "Command";

/** The command name without its suffix `Command`, or null when it has no such plain form. */
export function operationOf(commandName: unknown): string | null {
  return typeof commandName === "string" &&
    commandName.endsWith(COMMAND_SUFFIX) &&
    commandName.length > COMMAND_SUFFIX.length
    ? commandName.slice(0, -COMMAND_SUFFIX.length)
    : null;
}

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
    status:
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    requestId: plainRequestId(m["requestId"]),
  };
}

function safeName(value: string | null): string {
  return plainName(value) ?? "Unknown";
}

// Node codes of a request that never left the machine: AWS cannot have acted on it.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const ASSUME_ROLE = "AssumeRole";

const NETWORK_ROW = ROWS.length - 1;

// Conservative (R16): true unless the row proves that AWS did not run the request.
function mayHaveActed(f: Facts, index: number, row: Row | undefined, nodeCode: string | null) {
  if (f.status !== null && (f.status >= 500 || f.status < 300)) return true;
  if (row === undefined) return true; // unknown error: when unsure, assume it acted
  if (index === NETWORK_ROW) return nodeCode === null || !NOT_SENT_CODES.has(nodeCode);
  // Server and time-out rows: the request may have been processed.
  return row.code === "upstream_unavailable" && !isSetupName(f.name);
}

function classify(error: unknown, operation: string | null): AwsError {
  const f = readFacts(error);
  const index = ROWS.findIndex((r) => r.match(f));
  const row = ROWS[index];
  const nodeCode = f.code !== null && NODE_CODES.has(f.code) ? f.code : null;
  // An error of the credentials step is never final and never "acted": a platform fault waits
  // for an admin and does not fail an order.
  const credentialsStep = operation === ASSUME_ROLE;
  return new AwsError({
    code: row?.code ?? "internal",
    retryable: credentialsStep ? true : (row?.retryable ?? true),
    poolFull: row?.poolFull ?? false,
    // Row 11 is the only row that names the error by its network code.
    awsErrorName: safeName(index === NETWORK_ROW ? f.code : f.name),
    operation,
    httpStatus: f.status,
    requestId: f.requestId,
    mayHaveActed: credentialsStep ? false : mayHaveActed(f, index, row, nodeCode),
    nodeCode,
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
      mayHaveActed: operation !== ASSUME_ROLE,
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
  mayHaveActed: boolean;
  nodeCode: string | null;
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
    mayHaveActed: error.mayHaveActed,
    nodeCode: error.nodeCode,
  };
}

export function mapErrors(client: LightsailClient, onError?: (error: AwsError) => void): void;
export function mapErrors(client: Route53Client, onError?: (error: AwsError) => void): void;
export function mapErrors(client: STSClient): void;
export function mapErrors(
  client: LightsailClient | Route53Client | STSClient,
  onError?: (error: AwsError) => void,
): void {
  // The two clients have middleware stacks of different types: one cast, then one `add`.
  (client.middlewareStack as unknown as LightsailClient["middlewareStack"]).add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        const operation = operationOf(context.commandName);
        const mapped = toAwsError(error, operation);
        try {
          onError?.(mapped);
        } catch {
          // the observer must never change the error the caller gets
        }
        throw mapped;
      }
    },
    { step: "initialize", name: "tcErrorMapping", priority: "high" },
  );
}
