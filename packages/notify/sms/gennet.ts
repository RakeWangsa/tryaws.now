import { createHash, randomBytes } from "node:crypto";
import type { SmsTransport, SmsTransportRequest, SmsTransportResult } from "./gateway";

// WPU-Z3: the SMS gateway the owner chose, Gennet, through its white-label "ISMS" API v3: one POST of
// JSON per message with api_token, sid, msisdn, sms and csms_id. It is the only HTTP call of this package
// (test/boundary.test.ts names it). The web app sends the phone OTP through it and the notifier the
// notification SMS, both behind GatewaySmsProvider (gateway.ts: the E.164 and length checks, the time
// limit).
//
// The answer is mapped fail closed. Its format is taken from the public ISMS Plus v3 documentation of SSL
// Wireless, which has the same field names (VERIFY for Gennet, docs/runbooks/sms-gateway.md): a JSON
// object with `status` ("SUCCESS" or "FAILED"), a numeric `status_code`, `error_message` and `smsinfo`,
// an array whose items carry `sms_status` (SUCCESS, INVALID, DUPLICATE, BLOCKED), `status_message`,
// `csms_id` and `reference_id`, and echo the number and the text.
//   - accepted: HTTP 2xx, status SUCCESS and, when smsinfo is there, its first item SUCCESS.
//   - refused: the answer clearly says that the number or the text is invalid. Then the gateway will
//     never take it, and the caller stops (the OTP form shows a field error, the notifier fails the row).
//   - failed: everything else. A fault of ours or of the provider (token, sender id, IP whitelist,
//     balance, limits, duplicates, outage) must never mark a customer's number as bad; the notifier
//     retries it and pauses the channel.
//
// R3, R14: the token and the sender id are private fields (absent from JSON and inspect), and no result,
// error or log carries them, the number, the text or the body of the answer. Nothing is logged here.

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

// HTTP statuses about the content of the request. Every other 4xx (auth, payment, forbidden, not found,
// conflict, rate limit), every 3xx and every 5xx is failed whatever the body says.
const CONTENT_ERRORS: ReadonlySet<number> = new Set([400, 413, 422]);

// status_code values of the ISMS v3 answer (VERIFY for Gennet). These say that the number or the text is
// invalid: 4025 Invalid MSISDN, 4027 Message Length Exceeded, 4032 Invalid SMS.
const NUMBER_OR_TEXT_CODES: ReadonlySet<number> = new Set([4025, 4027, 4032]);
// These say something else: 4001 Unauthorized, 4002 SID Not Permitted, 4003 IP Blacklisted, 4004 Invalid
// Request Format, 4005 End Point Not Found, 4020 Invalid CSMS ID, 4022 Required Parameter Missing, 4023
// Duplicate CMS ID, 4024 Duplicate MSISDN, 4026 Blocked MSISDN, 4028 Invalid Message Data (the number, the
// body, the sender id or the csms_id), 4029 Too Many Requests, 4030 Limit Exceed, 4031 TPS Exceeded, 4033
// Too Many OTP Requests, 4034 Unable to Decrypt SMS, 4035 Client Signature Mismatch, 5000 Internal Error.
const OTHER_CODES: ReadonlySet<number> = new Set([
  4001, 4002, 4003, 4004, 4005, 4020, 4022, 4023, 4024, 4026, 4028, 4029, 4030, 4031, 4033, 4034,
  4035, 5000,
]);

// A message with one of these words puts the fault on our side or on the provider's, never on the number.
const OUR_SIDE =
  /token|api[\s_-]?key|auth|credential|password|permi(?:t|ss)|forbidden|\bsid\b|sender|\bmask|\bip\b|white[\s-]?list|black[\s-]?list|csms|duplicat|balance|credit|quota|limit|\btps\b|too many|expire|suspend|signature|decrypt|account/i;
// A message that names the number or the text ...
const NAMES_NUMBER_OR_TEXT =
  /\b(?:msisdn|mobile|number|phone|recipient|sms|message|text|body)s?\b/i;
// ... as invalid.
const SAYS_INVALID =
  /\b(?:invalid|not (?:a )?valid|incorrect|wrong|malformed|too long|length|exceed(?:s|ed)?)\b/i;

const REFUSED: SmsTransportResult = { status: "refused" };
const FAILED: SmsTransportResult = { status: "failed" };

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
    if (typeof to !== "string" || !BD_MOBILE.test(to)) return REFUSED;
    if (typeof text !== "string" || text.length === 0) return REFUSED;
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
      return FAILED;
    }
  }

  #interpret(httpStatus: number, raw: string, csmsId: string, msisdn: string): SmsTransportResult {
    const ok = httpStatus >= 200 && httpStatus < 300;
    if (!ok && !CONTENT_ERRORS.has(httpStatus)) return FAILED;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return FAILED;
    }
    if (!isObject(body)) return FAILED;
    const info = body.smsinfo;
    if (info !== undefined && info !== null && !Array.isArray(info)) return FAILED;
    const first: unknown = Array.isArray(info) ? info[0] : undefined;
    const item = isObject(first) ? first : null;
    if (
      ok &&
      upper(body.status) === "SUCCESS" &&
      (!Array.isArray(info) || upper(item?.sms_status) === "SUCCESS")
    ) {
      return { status: "accepted", messageId: this.#messageId(item?.reference_id, csmsId, msisdn) };
    }
    return refusedOrFailed(httpStatus, body, item);
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
    for (const key of ["error_message", "status_message"]) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return out;
}

// Not accepted: refused only when the answer clearly says that the number or the text is invalid.
function refusedOrFailed(httpStatus: number, body: Json, item: Json | null): SmsTransportResult {
  const code = codeOf(body.status_code);
  const messages = messagesOf(body, item);
  if (code !== null && OTHER_CODES.has(code)) return FAILED;
  if (messages.some((message) => OUR_SIDE.test(message))) return FAILED;
  if (code !== null && NUMBER_OR_TEXT_CODES.has(code)) return REFUSED;
  if (upper(item?.sms_status) === "INVALID") return REFUSED;
  if (messages.some((m) => NAMES_NUMBER_OR_TEXT.test(m) && SAYS_INVALID.test(m))) return REFUSED;
  return CONTENT_ERRORS.has(httpStatus) ? REFUSED : FAILED;
}
