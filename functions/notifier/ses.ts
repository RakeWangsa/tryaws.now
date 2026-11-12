import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { SesRequest, SesTransport } from "@tc/notify";

// WPU-D4: the SES transport of the notifier. One SESv2 SendEmail per message, with the text and the html
// body of the template, the verified from address and the identity ARN (R3: the Lambda role is the only
// credential, there is no key). The SDK client has no logger and one attempt: SESv2 SendEmail has no
// idempotency token, so a repeat inside the SDK could send a message twice. The row of the notifier is the
// idempotency unit: it is claimed before the send and marked after it (packages/notify/queue/run.ts).
// Failures carry a fixed text and a known error name only; the SES message can hold the address (R14).

export const SES_SEND_ERROR = "ses: send failed";

export interface SesClientLike {
  send(command: SendEmailCommand): Promise<{ readonly MessageId?: string | undefined }>;
}

export interface SesTransportOptions {
  readonly client: SesClientLike;
  /** Authorizes the from address when the identity is not in the sending account's own list. */
  readonly identityArn?: string | undefined;
  /** Only when infra defines one (event publishing for bounces and complaints; not defined yet). */
  readonly configurationSet?: string | undefined;
}

// SESv2 SendEmail error names that packages/notify/email/provider.ts maps; every other name is "SesError".
const KNOWN_ERRORS = new Set([
  "MessageRejected",
  "BadRequestException",
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotFoundException",
  "TooManyRequestsException",
  "LimitExceededException",
  "Timeout",
]);

// SES tag values: letters, digits, underscore, dash, dot, at sign; 1 to 256 characters.
const TAG_VALUE = /^[A-Za-z0-9_.@-]{1,256}$/;

function sesError(name: string): Error {
  return Object.assign(new Error(SES_SEND_ERROR), { name });
}

export function createSesTransport(options: SesTransportOptions): SesTransport {
  return {
    async send(request: SesRequest): Promise<{ readonly messageId: string }> {
      const charset = request.charset;
      const input = {
        FromEmailAddress: request.from,
        ...(options.identityArn === undefined
          ? {}
          : { FromEmailAddressIdentityArn: options.identityArn }),
        Destination: { ToAddresses: [request.to] },
        Content: {
          Simple: {
            Subject: { Data: request.subject, Charset: charset },
            Body: {
              Text: { Data: request.text, Charset: charset },
              Html: { Data: request.html, Charset: charset },
            },
          },
        },
        ...(options.configurationSet === undefined
          ? {}
          : { ConfigurationSetName: options.configurationSet }),
        EmailTags:
          request.tag !== undefined && TAG_VALUE.test(request.tag)
            ? [{ Name: "template", Value: request.tag }]
            : [],
      };
      let messageId: string | undefined;
      try {
        const out = await options.client.send(new SendEmailCommand(input));
        messageId = out.MessageId;
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw sesError(KNOWN_ERRORS.has(name) ? name : "SesError");
      }
      if (typeof messageId !== "string" || messageId === "") throw sesError("SesError");
      return { messageId };
    },
  };
}

// arn:aws:ses:<region>:<12 digits>:identity/<domain or address>; `$` without the `m` flag does not match
// before a trailing newline.
const IDENTITY_ARN =
  /^arn:aws:ses:([a-z]{2}-[a-z]+-[0-9]):[0-9]{12}:identity\/[A-Za-z0-9.@_+-]{1,254}$/;
const CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSesIdentityArn(value: unknown): { arn: string; region: string } | null {
  if (typeof value !== "string") return null;
  const match = IDENTITY_ARN.exec(value);
  return match === null ? null : { arn: value, region: match[1] as string };
}

/**
 * The transport of the Lambda environment, or null when it is not valid (the handler then fails closed,
 * R16). Builds no connection: the client connects on the first send.
 */
export function sesTransportFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SesTransport | null {
  const identity = parseSesIdentityArn(env.SES_IDENTITY_ARN);
  if (identity === null) return null;
  const set = env.SES_CONFIGURATION_SET;
  if (set !== undefined && set !== "" && !CONFIGURATION_SET.test(set)) return null;
  // No `logger` (the SDK would write raw errors, R14), no retry (see the header).
  const client = new SESv2Client({ region: identity.region, maxAttempts: 1 });
  return createSesTransport({
    client,
    identityArn: identity.arn,
    configurationSet: set === undefined || set === "" ? undefined : set,
  });
}
