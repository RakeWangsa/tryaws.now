import { Readable } from "node:stream";
import type { AwsRequestHandler } from "../types";
import { isNetworkGuardInstalled } from "./network-guard";

// Fail closed: without the guard, a real-transport test would reach AWS and sign with the
// developer's real credentials.
if (!isNetworkGuardInstalled()) {
  throw new Error(
    "packages/aws tests need the network guard: run them through the @tc/aws Vitest project (pnpm test --filter @tc/aws)",
  );
}

export type FakeReply =
  | { status: number; contentType: string; body: string }
  | { networkCode: string }
  | { errorName: string };

export interface SeenRequest {
  service: "sts" | "lightsail";
  host: string;
  action: string;
  body: string;
  authorization: string;
}

export interface FakeAws {
  handler: AwsRequestHandler;
  seen: SeenRequest[];
  on(service: "sts" | "lightsail", action: string, ...replies: FakeReply[]): void;
}

export const ASSUMED = {
  accessKeyId: "tc-test-assumed-key-1",
  secretAccessKey: "tc-test-assumed-secret-1",
  sessionToken: "tc-test-assumed-token-1",
};

export const RAW_ACCESS_DENIED =
  "User: arn:aws:sts::111111111111:assumed-role/tc-provisioner/s is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::210987654321:role/TcProvisioner";

export const LEAK = /arn:|111111111111|210987654321|not authorized/;

const STS_NS = "https://sts.amazonaws.com/doc/2011-06-15/";
const LIGHTSAIL_TARGET_PREFIX = "Lightsail_20161128.";

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function assumeRoleOk(c: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}): FakeReply {
  const body =
    `<AssumeRoleResponse xmlns="${STS_NS}"><AssumeRoleResult><Credentials>` +
    `<AccessKeyId>${xml(c.accessKeyId)}</AccessKeyId>` +
    `<SecretAccessKey>${xml(c.secretAccessKey)}</SecretAccessKey>` +
    `<SessionToken>${xml(c.sessionToken)}</SessionToken>` +
    `<Expiration>${xml(c.expiration)}</Expiration></Credentials>` +
    `<AssumedRoleUser><AssumedRoleId>AROAFAKEFAKEFAKEFAKE:fake</AssumedRoleId>` +
    `<Arn>arn:aws:sts::210987654321:assumed-role/TcProvisioner/fake</Arn></AssumedRoleUser>` +
    `</AssumeRoleResult><ResponseMetadata><RequestId>fake-sts</RequestId></ResponseMetadata>` +
    `</AssumeRoleResponse>`;
  return { status: 200, contentType: "text/xml", body };
}

export function stsError(status: number, code: string, message: string): FakeReply {
  const body =
    `<ErrorResponse xmlns="${STS_NS}"><Error><Type>Sender</Type><Code>${xml(code)}</Code>` +
    `<Message>${xml(message)}</Message></Error><RequestId>fake-sts</RequestId></ErrorResponse>`;
  return { status, contentType: "text/xml", body };
}

export function lightsailOk(json: unknown): FakeReply {
  return {
    status: 200,
    contentType: "application/x-amz-json-1.1",
    body: JSON.stringify(json),
  };
}

export function lightsailError(status: number, type: string, message: string): FakeReply {
  return {
    status,
    contentType: "application/x-amz-json-1.1",
    body: JSON.stringify({ __type: type, message }),
  };
}

type FakeHandler = Extract<AwsRequestHandler, { handle: unknown }>;

function serviceOf(host: string): "sts" | "lightsail" | undefined {
  if (host.startsWith("sts.")) return "sts";
  if (host.startsWith("lightsail.") || host.startsWith("lightsail-fips.")) return "lightsail";
  return undefined;
}

function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

export function fakeAws(): FakeAws {
  const seen: SeenRequest[] = [];
  const scripts = new Map<string, { replies: FakeReply[]; used: number }>();
  let counter = 0;

  const handler: FakeHandler = {
    async handle(request: Parameters<FakeHandler["handle"]>[0]) {
      const host = request.hostname;
      const service = serviceOf(host);
      if (service === undefined) throw new Error(`fake-aws: unknown service host ${host}`);
      counter += 1;
      const requestId = `fake-request-${counter}`;
      const body = bodyText(request.body);
      const authorization = header(request.headers, "authorization");
      let action: string;
      if (service === "sts") {
        action = new URLSearchParams(body).get("Action") ?? "";
      } else {
        const target = header(request.headers, "x-amz-target");
        action = target.startsWith(LIGHTSAIL_TARGET_PREFIX)
          ? target.slice(LIGHTSAIL_TARGET_PREFIX.length)
          : target;
      }
      seen.push({ service, host, action, body, authorization });

      const script = scripts.get(`${service} ${action}`);
      if (script === undefined || script.replies.length === 0) {
        throw new Error(`fake-aws: no reply for ${service} ${action}`);
      }
      const reply = script.replies[Math.min(script.used, script.replies.length - 1)]!;
      script.used += 1;

      if ("networkCode" in reply) {
        throw Object.assign(new Error("fake socket error"), { code: reply.networkCode });
      }
      if ("errorName" in reply) {
        throw Object.assign(new Error("fake timeout"), { name: reply.errorName });
      }
      return {
        response: {
          statusCode: reply.status,
          headers: { "content-type": reply.contentType, "x-amzn-requestid": requestId },
          body: Readable.from([Buffer.from(reply.body)]),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };

  return {
    handler,
    seen,
    on(service, action, ...replies) {
      scripts.set(`${service} ${action}`, { replies, used: 0 });
    },
  };
}
