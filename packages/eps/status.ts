import { parseEpsAmount } from "./amount";

export type EpsStatus = "success" | "failed" | "cancelled" | "pending" | "unknown";

/** VERIFY (open point 6.4): the alias table comes from the skill. Anything not listed is unknown (R16). */
export function normalizeEpsStatus(raw: unknown): EpsStatus {
  if (typeof raw !== "string") return "unknown";
  switch (raw.toUpperCase()) {
    case "SUCCESS":
    case "COMPLETED":
      return "success";
    case "FAILED":
    case "FAILURE":
      return "failed";
    case "CANCEL":
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    case "PENDING":
      return "pending";
    default:
      return "unknown";
  }
}

export interface VerifyReading {
  status: EpsStatus;
  merchantTransactionId: string | null;
  epsTransactionId: string | null;
  totalAmountMinor: bigint | null;
  errorCode: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Reads a verify answer. Never throws; a malformed body gives status unknown and nulls. */
export function readVerifyResponse(body: unknown): VerifyReading {
  if (!isRecord(body)) {
    return {
      status: "unknown",
      merchantTransactionId: null,
      epsTransactionId: null,
      totalAmountMinor: null,
      errorCode: null,
    };
  }
  const data = isRecord(body.data) ? body.data : {};
  const candidates = [
    body.Status,
    body.transactionStatus,
    body.status,
    data.transactionStatus,
    data.status,
  ];
  let status: EpsStatus = "unknown";
  const seen = new Set<EpsStatus>();
  for (const c of candidates) {
    if (text(c) !== null) seen.add(normalizeEpsStatus(c));
  }
  if (seen.size === 1) status = [...seen][0] ?? "unknown";
  return {
    status,
    merchantTransactionId: text(body.MerchantTransactionId),
    epsTransactionId: text(body.EpsTransactionId) ?? text(body.EPSTransactionId),
    totalAmountMinor: parseEpsAmount(body.TotalAmount),
    errorCode: text(body.ErrorCode),
  };
}
