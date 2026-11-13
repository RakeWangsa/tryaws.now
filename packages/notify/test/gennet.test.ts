import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmsTransportResult } from "../sms/gateway";
import { GENNET_SEND_URL, GennetSmsTransport, csmsIdFor } from "../sms/gennet";

// WPU-Z3: the Gennet transport (ISMS API v3) over an injected fetch. No network call is made. The
// token and the sender id are obviously fake (R3); the answers follow the public ISMS Plus v3 format of
// SSL Wireless, which the Gennet API is believed to share (VERIFY, docs/runbooks/sms-gateway.md).
const TOKEN = "fake-gennet-token-for-unit-tests";
const SENDER = "FAKESENDERID";
const TO = "+8801712345678";
const MSISDN = "8801712345678";
const CODE = "123456";
const TEXT = `TryAWS.now Your OTP is: ${CODE}. Please do not share your OTP with anyone.`;
const URL_OF_THE_API = "https://isms.gennet.com.bd/api/v3/send-sms";

interface Answer {
  readonly status?: number;
  // JSON-encoded as the body, unless `raw` is given
  readonly body?: unknown;
  readonly raw?: string;
}

function fakeFetch(answer: Answer | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (answer instanceof Error) throw answer;
    const raw = answer.raw ?? JSON.stringify(answer.body ?? {});
    return new Response(raw, { status: answer.status ?? 200 });
  });
  return { fetch: mock as unknown as typeof fetch, mock, calls };
}

const make = (answer: Answer | Error) => {
  const fake = fakeFetch(answer);
  return {
    transport: new GennetSmsTransport({ apiToken: TOKEN, senderId: SENDER, fetch: fake.fetch }),
    ...fake,
  };
};

// One item of `smsinfo`, as the provider answers it (it echoes the number and the text).
const item = (over: Record<string, unknown> = {}) => ({
  sms_status: "SUCCESS",
  status_message: "Success",
  msisdn: MSISDN,
  sms_type: "EN",
  sms_body: TEXT,
  csms_id: "ECHOEDBACKBYPROVIDER",
  reference_id: "5ff2be7f64f61",
  ...over,
});
const success = (over: Record<string, unknown> = {}) => ({
  status: "SUCCESS",
  status_code: 200,
  error_message: "",
  smsinfo: [item(over)],
});
const failure = (code: number | string | null, message: string) => ({
  status: "FAILED",
  ...(code === null ? {} : { status_code: code }),
  error_message: message,
});

const sendWith = async (answer: Answer | Error, reference?: string) => {
  const { transport } = make(answer);
  return transport.send(
    reference === undefined ? { to: TO, text: TEXT } : { to: TO, text: TEXT, reference },
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GennetSmsTransport: the request", () => {
  it("posts JSON to the constant URL with the five fields of the API and the two JSON headers", async () => {
    const { transport, calls } = make({ body: success() });
    await transport.send({ to: TO, text: TEXT, reference: "ref-1" });
    expect(GENNET_SEND_URL).toBe(URL_OF_THE_API);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(URL_OF_THE_API);
    expect(call!.init.method).toBe("POST");
    // a redirect would carry the token to another address: it is an error, never followed
    expect(call!.init.redirect).toBe("error");
    const headers = new Headers(call!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    const body = JSON.parse(String(call!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["api_token", "sid", "msisdn", "sms", "csms_id"]);
    expect(body).toEqual({
      api_token: TOKEN,
      sid: SENDER,
      msisdn: MSISDN,
      sms: TEXT,
      csms_id: csmsIdFor("ref-1"),
    });
  });

  it.each(["3", "4", "5", "6", "7", "8", "9"])(
    "sends a mobile number of the operator digit %s as 8801... without the plus",
    async (digit) => {
      const { transport, calls } = make({ body: success() });
      await transport.send({ to: `+8801${digit}12345678`, text: TEXT });
      const body = JSON.parse(String(calls[0]!.init.body)) as { msisdn: string };
      expect(body.msisdn).toBe(`8801${digit}12345678`);
    },
  );

  it("refuses any other number, and an empty text, without a network call", async () => {
    const { transport, mock } = make({ body: success() });
    for (const to of [
      "+447911123456",
      "01712345678",
      MSISDN,
      "+8801212345678",
      "+8801012345678",
      "+880171234567",
      "+88017123456789",
      " +8801712345678",
      "+8801712345678\n",
      "+88 01712345678",
      "+8801712 345678",
      "",
    ]) {
      expect(await transport.send({ to, text: TEXT }), JSON.stringify(to)).toEqual({
        status: "refused",
      });
    }
    expect(await transport.send({ to: TO, text: "" })).toEqual({ status: "refused" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("uses globalThis.fetch when no fetch is injected, looked up at the time of the send", async () => {
    const fake = fakeFetch({ body: success() });
    const transport = new GennetSmsTransport({ apiToken: TOKEN, senderId: SENDER });
    vi.stubGlobal("fetch", fake.fetch);
    expect(await transport.send({ to: TO, text: TEXT })).toMatchObject({ status: "accepted" });
    expect(fake.calls.map((c) => c.url)).toEqual([URL_OF_THE_API]);
  });
});

describe("csms_id: our id of each message", () => {
  it("is 20 characters of A-Z and 0-9, the same for the same reference and different for different ones", () => {
    const id = "0193f7c2-5b8a-7c3e-9a1b-1234567890ab";
    const a = csmsIdFor(id);
    expect(a).toMatch(/^[A-Z0-9]{20}$/);
    expect(csmsIdFor(id)).toBe(a);
    expect(csmsIdFor("0193f7c2-5b8a-7c3e-9a1b-1234567890ac")).not.toBe(a);
    const many = Array.from({ length: 1000 }, (_, i) => csmsIdFor(`row-${i}`));
    for (const value of many) expect(value).toMatch(/^[A-Z0-9]{20}$/);
    expect(new Set(many).size).toBe(1000);
  });

  it("is random when no reference, or an empty one, is given", () => {
    const many = Array.from({ length: 200 }, () => csmsIdFor());
    for (const value of many) expect(value).toMatch(/^[A-Z0-9]{20}$/);
    expect(new Set(many).size).toBe(200);
    expect(csmsIdFor("")).toMatch(/^[A-Z0-9]{20}$/);
    expect(csmsIdFor("")).not.toBe(csmsIdFor(""));
  });

  it("a repeat of the same message carries the same csms_id; a message without a reference a fresh one", async () => {
    const { transport, calls } = make({ body: success() });
    await transport.send({ to: TO, text: TEXT, reference: "row-7" });
    await transport.send({ to: TO, text: TEXT, reference: "row-7" });
    await transport.send({ to: TO, text: TEXT });
    const ids = calls.map((c) => (JSON.parse(String(c.init.body)) as { csms_id: string }).csms_id);
    expect(ids[0]).toBe(csmsIdFor("row-7"));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toMatch(/^[A-Z0-9]{20}$/);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("GennetSmsTransport: the answer, fail closed", () => {
  it("accepted: status SUCCESS and an smsinfo item of SUCCESS; the message id is the provider's reference_id", async () => {
    expect(await sendWith({ body: success() }, "ref-2")).toEqual({
      status: "accepted",
      messageId: "5ff2be7f64f61",
    });
  });

  it("accepted: the status is read without regard to case, and without smsinfo the message id is our csms_id", async () => {
    expect(await sendWith({ body: { status: "success", status_code: 200 } }, "ref-3")).toEqual({
      status: "accepted",
      messageId: csmsIdFor("ref-3"),
    });
    expect(
      await sendWith({ status: 201, body: success({ sms_status: "Success" }) }, "ref-3"),
    ).toEqual({ status: "accepted", messageId: "5ff2be7f64f61" });
  });

  it("a reference_id that is empty, not a string, not a plain id, or that holds the number, the token or the sender id gives our csms_id", async () => {
    for (const reference_id of [
      "",
      42,
      null,
      "has space",
      "x".repeat(65),
      MSISDN + "\n",
      MSISDN,
      `ref-${MSISDN.slice(-10)}`,
      TOKEN,
      SENDER,
      `id-${SENDER.toLowerCase()}`,
    ]) {
      expect(
        await sendWith({ body: success({ reference_id }) }, "ref-4"),
        String(reference_id),
      ).toEqual({ status: "accepted", messageId: csmsIdFor("ref-4") });
    }
  });

  it.each([
    [4001, "Unauthorized"],
    [4002, "SID Not Permitted"],
    [4003, "IP Blacklisted"],
    [4004, "Invalid Request Format"],
    [4005, "End Point Not Found"],
    [4020, "Invalid CSMS ID"],
    [4022, "Required Parameter Missing"],
    [4023, "Duplicate CMS ID"],
    [4024, "Duplicate MSISDN"],
    [4026, "Blocked MSISDN"],
    [4028, "Invalid Message Data"],
    [4029, "Too Many Requests"],
    [4030, "Limit Exceed"],
    [4031, "TPS Exceeded"],
    [4033, "Too Many OTP Requests"],
    [4034, "Unable to Decrypt SMS"],
    [4035, "Client Signature Mismatch"],
    [5000, "Internal Error"],
    ["4001", "Unauthorized"],
    [null, "Invalid API token"],
    [null, "Invalid sender ID"],
    [null, "Your IP is not whitelisted"],
    [null, "Insufficient balance"],
    [null, "SMS limit exceeded"],
    [null, "Invalid SMS signature"],
    [null, "Duplicated CSMS ID for this message"],
    [null, "Something new happened"],
    [null, ""],
  ] as const)(
    "failed: a FAILED answer %s %j does not say that the number or the text is invalid",
    async (code, message) => {
      expect(await sendWith({ body: failure(code, message) })).toEqual({ status: "failed" });
    },
  );

  it.each([
    [4025, "Invalid MSISDN"],
    [4027, "Message Length Exceeded"],
    [4032, "Invalid SMS"],
    ["4025", "Invalid MSISDN"],
    [null, "Invalid MSISDN"],
    [null, "Invalid mobile number"],
    [null, "The phone number is not a valid one"],
    [null, "Wrong number"],
    [null, "Message length exceeded"],
    [null, "SMS text too long"],
  ] as const)(
    "refused: a FAILED answer %s %j says that the number or the text is invalid",
    async (code, message) => {
      expect(await sendWith({ body: failure(code, message) })).toEqual({ status: "refused" });
    },
  );

  it("refused also when the status_message of the smsinfo item names the number as invalid", async () => {
    const body = {
      status: "FAILED",
      error_message: "",
      smsinfo: [
        item({ sms_status: "INVALID", status_message: "Invalid MSISDN", sms_body: undefined }),
      ],
    };
    expect(await sendWith({ body })).toEqual({ status: "refused" });
  });

  it("with status SUCCESS the smsinfo item decides: INVALID is refused, DUPLICATE, BLOCKED and anything else failed", async () => {
    expect(
      await sendWith({
        body: success({ sms_status: "INVALID", status_message: "Invalid MSISDN" }),
      }),
    ).toEqual({ status: "refused" });
    expect(
      await sendWith({
        body: success({ sms_status: "DUPLICATE", status_message: "Duplicated CSMS ID" }),
      }),
    ).toEqual({ status: "failed" });
    expect(
      await sendWith({
        body: success({ sms_status: "BLOCKED", status_message: "Blocked MSISDN" }),
      }),
    ).toEqual({ status: "failed" });
    expect(await sendWith({ body: success({ sms_status: "QUEUED", status_message: "" }) })).toEqual(
      {
        status: "failed",
      },
    );
    expect(await sendWith({ body: success({ sms_status: undefined }) })).toEqual({
      status: "failed",
    });
  });

  it("status SUCCESS with an empty, malformed or non-array smsinfo is failed", async () => {
    for (const smsinfo of [[], [null], ["SUCCESS"], { sms_status: "SUCCESS" }, "SUCCESS"]) {
      expect(
        await sendWith({ body: { status: "SUCCESS", smsinfo } }),
        JSON.stringify(smsinfo),
      ).toEqual({
        status: "failed",
      });
    }
    expect(await sendWith({ body: { status_code: 200, smsinfo: [item()] } })).toEqual({
      status: "failed",
    });
  });

  it("HTTP 5xx and 3xx are failed whatever the body says", async () => {
    for (const status of [500, 502, 503, 504, 300]) {
      expect(await sendWith({ status, body: success() }), String(status)).toEqual({
        status: "failed",
      });
      expect(
        await sendWith({ status, body: failure(4025, "Invalid MSISDN") }),
        String(status),
      ).toEqual({ status: "failed" });
    }
  });

  it("HTTP 401, 402, 403, 404, 408, 409 and 429 are failed whatever the body says (auth, payment, limits)", async () => {
    for (const status of [401, 402, 403, 404, 408, 409, 429]) {
      expect(
        await sendWith({ status, body: failure(4025, "Invalid MSISDN") }),
        String(status),
      ).toEqual({ status: "failed" });
    }
  });

  it("HTTP 400, 413 and 422 are refused, unless the body names a fault of ours or carries such a code", async () => {
    for (const status of [400, 413, 422]) {
      expect(
        await sendWith({ status, body: failure(null, "Bad request") }),
        String(status),
      ).toEqual({
        status: "refused",
      });
      expect(await sendWith({ status, body: {} }), String(status)).toEqual({ status: "refused" });
      expect(
        await sendWith({ status, body: failure(4001, "Unauthorized") }),
        String(status),
      ).toEqual({ status: "failed" });
      expect(
        await sendWith({ status, body: failure(null, "Invalid api_token") }),
        String(status),
      ).toEqual({ status: "failed" });
      // a 4xx with an answer of success is not a success
      expect(await sendWith({ status, body: success() }), String(status)).toEqual({
        status: "refused",
      });
    }
  });

  it("a body that is not JSON, or JSON that is not an object, is failed, also with HTTP 400", async () => {
    for (const raw of ["<html>Bad Gateway</html>", "", "null", "[]", '"SUCCESS"', "{", "42"]) {
      expect(await sendWith({ raw }), JSON.stringify(raw)).toEqual({ status: "failed" });
      expect(await sendWith({ status: 400, raw }), JSON.stringify(raw)).toEqual({
        status: "failed",
      });
    }
  });

  it("a network error is failed, and nothing is thrown", async () => {
    const result = await sendWith(
      new TypeError(`fetch failed for ${TOKEN} ${SENDER} ${TO} ${TEXT}`),
    );
    expect(result).toEqual({ status: "failed" });
  });

  it("a body that cannot be read is failed", async () => {
    const broken = {
      status: 200,
      ok: true,
      text: () => Promise.reject(new Error(`stream broke ${TEXT}`)),
      json: () => Promise.reject(new Error(`stream broke ${TEXT}`)),
    } as unknown as Response;
    const transport = new GennetSmsTransport({
      apiToken: TOKEN,
      senderId: SENDER,
      fetch: (() => Promise.resolve(broken)) as unknown as typeof fetch,
    });
    expect(await transport.send({ to: TO, text: TEXT })).toEqual({ status: "failed" });
  });
});

describe("GennetSmsTransport: secrets and personal data (R3, R14)", () => {
  it("no result carries the token, the sender id, the number or the text, and send never throws", async () => {
    const leaky = `${TOKEN} ${SENDER} ${MSISDN} ${TO} ${TEXT}`;
    const answers: (Answer | Error)[] = [
      { body: success() },
      { body: success({ reference_id: TOKEN }) },
      { body: success({ reference_id: MSISDN }) },
      { body: failure(4025, `Invalid MSISDN ${MSISDN}`) },
      { body: failure(4001, `Unauthorized ${TOKEN}`) },
      { body: failure(null, leaky) },
      { status: 500, raw: leaky },
      { status: 400, raw: leaky },
      { raw: leaky },
      new Error(leaky),
    ];
    const results: SmsTransportResult[] = [];
    for (const answer of answers) results.push(await sendWith(answer, "ref-5"));
    const shown = JSON.stringify(results);
    for (const value of [TOKEN, SENDER, MSISDN, CODE, "TryAWS.now"]) {
      expect(shown).not.toContain(value);
    }
  });

  it("the transport shows neither the token nor the sender id in JSON or in inspect", () => {
    const transport = new GennetSmsTransport({ apiToken: TOKEN, senderId: SENDER });
    const shown = [
      JSON.stringify(transport),
      JSON.stringify({ transport }),
      inspect(transport, { depth: 10, showHidden: true }),
      String(transport),
      Object.keys(transport).join(","),
    ].join("\n");
    expect(shown).not.toContain(TOKEN);
    expect(shown).not.toContain(SENDER);
  });

  it("refuses to be built without a token or a sender id, with a fixed message that holds no value", () => {
    for (const options of [
      { apiToken: "", senderId: SENDER },
      { apiToken: TOKEN, senderId: "" },
      { apiToken: undefined, senderId: SENDER },
      { apiToken: TOKEN, senderId: undefined },
      { apiToken: 42, senderId: SENDER },
    ]) {
      let message = "";
      try {
        new GennetSmsTransport(options as never);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message, JSON.stringify(options)).toBe(
        "gennet: the api token and the sender id are required",
      );
    }
  });
});
