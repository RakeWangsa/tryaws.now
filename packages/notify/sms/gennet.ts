import { createHash, randomBytes } from "node:crypto";
import type { SmsTransport, SmsTransportRequest, SmsTransportResult } from "./gateway";
import type { SmsFailureDetail } from "./provider";

// WPU-Z3: the SMS gateway the owner chose, Gennet, through its white-label "ISMS" API v3: one POST of
// JSON per message with api_token, sid, msisdn, sms and csms_id. It is the only HTTP call of this package
// (test/boundary.test.ts names it). The web app sends the phone OTP through it and the notifier the
// notification SMS, both behind GatewaySmsProvider (gateway.ts: the E.164 and length checks, the time
// limit).
//
// The answer is mapped fail closed and read by its status code (WPU-Z17). Its format is taken from the
// public ISMS Plus v3 documentation of SSL Wireless, which has the same field names (VERIFY for Gennet,
// docs/runbooks/sms-gateway.md, docs/analysis/gennet-isms-api-2026-11-13.md): a JSON object with
// `status` ("SUCCESS" or "FAILED"), a numeric `status_code`, `error_message` and `smsinfo`, an array
// whose items carry `sms_status` (SUCCESS, INVALID, DUPLICATE, BLOCKED), `status_message`, `csms_id` and
// `reference_id`, and echo the number and the text. A second shape (the test fixtures of a third-party
// Gennet SDK) has `status_meaning` and `description` instead of `error_message`. A failure may come with HTTP 200 and
// status FAILED (that SDK says Gennet answers so; VERIFY), so the HTTP status alone never refuses.
//   - accepted: HTTP 2xx, status SUCCESS and, when smsinfo is there, its first item SUCCESS.
//   - refused, reason `invalid_number`: status_code 4025 or 4028, or an smsinfo item INVALID or BLOCKED,
//     in an answer of HTTP 2xx, 400, 413 or 422. The number or the text is wrong and retrying cannot
//     help: the caller stops (the OTP form shows a field error, the notifier fails the row).
//   - failed: everything else, with a reason word for the caller's log: `token` (4001), `sender` (4002),
//     `ip_not_whitelisted` (4003), `duplicate` (4023, an item DUPLICATE), `rate_limited` (4029, 4031,
//     4033), `unknown` (any other code, no code, a body that is not JSON, a network error). A fault of
//     ours or of the provider must never mark a customer's number as bad; the notifier retries it and
//     pauses the channel.
//
// R3, R14: the token and the sender id are private fields (absent from JSON and inspect), and no result,
// error or log carries them, the number, the text or the body of the answer: the messages of the answer
// are read only to pick a reason word, and the result holds the word. Nothing is logged here.

export const GENNET_SEND_URL = "https://isms.gennet.com.bd/api/v3/send-sms";

export interface GennetOptions {
  readonly apiToken: string;
  readonly senderId: string;
  // Default: globalThis.fetch, looked up at each send.
  readonly fetch?: typeof fetch;
}

const OPTIONS_ERROR = "gennet: the api token and the sender id are required";

// A mobile number of Bangladesh in E.164: +880, 1, the operator digit 3 to 9, then eight digits.
const BD_MOBILE = /^\+8801[3-9][0-9]{8}$/;

// csms_id, our unique id of the message: 20 characters (the most the API takes) of the RFC 4648 base32
// alphabet, a subset of A-Z and 0-9. A SHA-256 of a fixed label and the caller's reference, so that a
// repeat of the same message (a retried notification row) keeps its id, or random when there is none.
const CSMS_ID_LENGTH = 20;
const CSMS_ID_LABEL = "tc.sms.csms_id.v1";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// The provider's id of an accepted message becomes our message id only when it is a plain id.
const PLAIN_ID = /^[A-Za-z0-9._:-]{1,64}$/;

// HTTP statuses of an answer about the content of the request. Besides 2xx, only these may refuse;
// every other status (3xx, any other 4xx, 5xx) is failed whatever the body says, but its reason word is
// still read from the body.
const CONTENT_ERRORS: ReadonlySet<number> = new Set([400, 413, 422]);

// Every status_code of the ISMS v3 table (VERIFY for Gennet) and its reason word. `invalid_number` is
// the one refusal.
const CODE_REASONS: ReadonlyMap<number, SmsFailureDetail> = new Map<number, SmsFailureDetail>([
  [4001, "token"], // Unauthorized
  [4002, "sender"], // SID Not Permitted
  [4003, "ip_not_whitelisted"], // IP Blacklisted
  [4004, "unknown"], // Invalid Request Format
  [4005, "unknown"], // End Point Not Found
  [4020, "unknown"], // Invalid CSMS ID
  [4022, "unknown"], // Required Parameter Missing
  [4023, "duplicate"], // Duplicate CMS ID
  [4024, "unknown"], // Duplicate MSISDN
  [4025, "invalid_number"], // Invalid MSISDN
  [4026, "unknown"], // Blocked MSISDN (refused only with an item BLOCKED)
  [4027, "unknown"], // Message Length Exceeded
  [4028, "invalid_number"], // Invalid Message Data (the table also names the sender id and the csms_id)
  [4029, "rate_limited"], // Too Many Requests
  [4030, "unknown"], // Limit Exceed (more than 100 numbers)
  [4031, "rate_limited"], // TPS Exceeded
  [4032, "unknown"], // Invalid SMS body
  [4033, "rate_limited"], // Too Many OTP Requests
  [4034, "unknown"], // Unable to Decrypt SMS
  [4035, "unknown"], // Client Signature Mismatch
  [5000, "unknown"], // Internal Error
]);

// For an answer without a code of the table only: words of its messages that name a fault of ours or of
// the provider, the most specific first. Words never refuse.
const REASON_WORDS: ReadonlyArray<readonly [SmsFailureDetail, RegExp]> = [
  ["duplicate", /duplicat/i],
  ["rate_limited", /too many|rate[\s_-]?limit|\btps\b|throttl/i],
  ["ip_not_whitelisted", /white[\s_-]?list|black[\s_-]?list/i],
  ["sender", /\bsid\b|sender|stakeholder|\bmask/i],
  ["token", /token|api[\s_-]?key|authori[sz]|authenticat/i],
];

// The messages of both answer shapes, at the top level and in the smsinfo item.
const MESSAGE_KEYS = ["error_message", "status_message", "status_meaning", "description"] as const;

const REFUSED_NUMBER: SmsTransportResult = { status: "refused", detail: "invalid_number" };
// An empty text has no reason word (GatewaySmsProvider refuses it before the transport).
const REFUSED_TEXT: SmsTransportResult = { status: "refused" };
const FAILED_UNKNOWN: SmsTransportResult = { status: "failed", detail: "unknown" };

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const upper = (value: unknown): string | null =>
  typeof value === "string" ? value.trim().toUpperCase() : null;

const codeOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]{1,6}$/.test(value.trim())) return Number(value.trim());
  return null;
};

function base32(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    // At most 4 bits are left over from the byte before, so 12 bits always hold what is still needed.
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >> bits) & 31);
      if (out.length === length) return out;
    }
  }
  return out;
}

/** Our id of one message: stable for the same non-empty reference, random without one. */
export function csmsIdFor(reference?: string): string {
  const seed =
    typeof reference === "string" && reference.length > 0
      ? createHash("sha256").update(`${CSMS_ID_LABEL}\u0000${reference}`, "utf8").digest()
      : randomBytes(16);
  return base32(seed, CSMS_ID_LENGTH);
}

export class GennetSmsTransport implements SmsTransport {
  readonly #apiToken: string;
  readonly #senderId: string;
  readonly #fetch: typeof fetch | undefined;

  constructor(options: GennetOptions) {
    const apiToken: unknown = options?.apiToken;
    const senderId: unknown = options?.senderId;
    if (
      typeof apiToken !== "string" ||
      apiToken.length === 0 ||
      typeof senderId !== "string" ||
      senderId.length === 0
    ) {
      throw new TypeError(OPTIONS_ERROR);
    }
    this.#apiToken = apiToken;
    this.#senderId = senderId;
    this.#fetch = options.fetch;
  }

  async send(request: SmsTransportRequest): Promise<SmsTransportResult> {
    const { to, text, reference } = request;
    // Only a Bangladesh mobile number is sent, and never an empty text: anything else is refused
    // before the network.
    if (typeof to !== "string" || !BD_MOBILE.test(to)) return REFUSED_NUMBER;
    if (typeof text !== "string" || text.length === 0) return REFUSED_TEXT;
    const msisdn = to.slice(1);
    const csmsId = csmsIdFor(reference);
    const post = this.#fetch ?? globalThis.fetch;
    try {
      const response = await post(GENNET_SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          api_token: this.#apiToken,
          sid: this.#senderId,
          msisdn,
          sms: text,
          csms_id: csmsId,
        }),
        // A redirect would carry the token to another address: it fails the send, never followed.
        redirect: "error",
      });
      const raw = await response.text();
      return this.#interpret(response.status, raw, csmsId, msisdn);
    } catch {
      // A network error, a refused redirect or an unreadable body. The error may hold the request: it
      // is dropped (R14).
      return FAILED_UNKNOWN;
    }
  }

  #interpret(httpStatus: number, raw: string, csmsId: string, msisdn: string): SmsTransportResult {
    const ok = httpStatus >= 200 && httpStatus < 300;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return FAILED_UNKNOWN;
    }
    if (!isObject(body)) return FAILED_UNKNOWN;
    const info = body.smsinfo;
    // A smsinfo that is there but not an array is never a success.
    const malformed = info !== undefined && info !== null && !Array.isArray(info);
    const first: unknown = Array.isArray(info) ? info[0] : undefined;
    const item = isObject(first) ? first : null;
    if (
      ok &&
      !malformed &&
      upper(body.status) === "SUCCESS" &&
      (!Array.isArray(info) || upper(item?.sms_status) === "SUCCESS")
    ) {
      return { status: "accepted", messageId: this.#messageId(item?.reference_id, csmsId, msisdn) };
    }
    const reason = reasonOf(body, item);
    if (reason !== "invalid_number") return { status: "failed", detail: reason };
    return ok || CONTENT_ERRORS.has(httpStatus) ? REFUSED_NUMBER : FAILED_UNKNOWN;
  }

  // The provider's reference_id when it is a plain id that holds neither the number nor a secret;
  // otherwise our csms_id (R14).
  #messageId(reference: unknown, csmsId: string, msisdn: string): string {
    if (typeof reference !== "string" || !PLAIN_ID.test(reference)) return csmsId;
    const lower = reference.toLowerCase();
    const leaks = [msisdn.slice(-10), this.#apiToken, this.#senderId].some((value) =>
      lower.includes(value.toLowerCase()),
    );
    return leaks ? csmsId : reference;
  }
}

function messagesOf(body: Json, item: Json | null): string[] {
  const out: string[] = [];
  for (const source of item === null ? [body] : [body, item]) {
    for (const key of MESSAGE_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return out;
}

// The reason word of an answer that is not a success. A signal of a fault of ours or of the provider
// wins over a refusal, so that such a fault never marks a customer's number as bad:
//   1. an item DUPLICATE is `duplicate`, whatever the code (the ISMS documentation shows it with 4028);
//   2. a code of the table that names such a fault (token, sender, IP, duplicate, rate) is its word;
//   3. an item INVALID or BLOCKED is `invalid_number`;
//   4. any other code of the table is its word (4025 and 4028 `invalid_number`, the rest `unknown`);
//   5. without a code of the table, the words of the messages pick one of the faults of step 2;
//   6. otherwise `unknown`.
function reasonOf(body: Json, item: Json | null): SmsFailureDetail {
  const itemStatus = upper(item?.sms_status);
  if (itemStatus === "DUPLICATE") return "duplicate";
  const code = codeOf(body.status_code);
  const byCode = code === null ? undefined : CODE_REASONS.get(code);
  if (byCode !== undefined && byCode !== "invalid_number" && byCode !== "unknown") return byCode;
  if (itemStatus === "INVALID" || itemStatus === "BLOCKED") return "invalid_number";
  if (byCode !== undefined) return byCode;
  const messages = messagesOf(body, item);
  for (const [reason, words] of REASON_WORDS) {
    if (messages.some((message) => words.test(message))) return reason;
  }
  return "unknown";
}
