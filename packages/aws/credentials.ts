import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { Clock } from "@tc/core";
import { AwsError, mapErrors, toAwsError } from "./errors";
import {
  assertRoleAllowed,
  checkedAccountRef,
  roleArn,
  sessionName,
  type AccountRef,
  type Caller,
  type RoleName,
} from "./roles";
import { REFRESH_MARGIN_MS, SESSION_SECONDS, STS_REGION, clientSettings } from "./settings";
import type { AwsRequestHandler } from "./types";

const REDACTED = "[temporary AWS credentials]";
const OPERATION = "AssumeRole";

export function createStsClient(requestHandler?: AwsRequestHandler): STSClient {
  // No `credentials` option: in a Lambda function the SDK's default chain reads the execution
  // role's temporary credentials (R3). No `logger` either: the SDK would log the raw AWS error.
  const client = new STSClient({
    region: STS_REGION,
    ...clientSettings("sts"),
    ...(requestHandler ? { requestHandler } : {}),
  });
  mapErrors(client);
  return client;
}

/**
 * Temporary credentials of a pool account role. The fields are plain and enumerable because the
 * SDK reads (and annotates) the object; printing or serialising it shows no secret (R3, R14).
 */
export class SessionCredentials {
  constructor(
    readonly accessKeyId: string,
    readonly secretAccessKey: string,
    readonly sessionToken: string,
    readonly expiration: Date,
  ) {}

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface CredentialCache {
  get(account: AccountRef, role: RoleName): Promise<SessionCredentials>;
}

export interface CredentialCacheDeps {
  sts: STSClient;
  caller: Caller;
  clock: Clock;
  randomHex16?: () => string;
}

const defaultRandomHex16 = () => randomUUID().replaceAll("-", "").slice(0, 16);

function invalidResponse(): AwsError {
  return new AwsError({
    code: "upstream_unavailable",
    retryable: true,
    reason: "sts_response_invalid",
    operation: OPERATION,
  });
}

export function createCredentialCache(deps: CredentialCacheDeps): CredentialCache {
  const { sts, caller, clock } = deps;
  const randomHex16 = deps.randomHex16 ?? defaultRandomHex16;
  // Private to this closure: nothing of the credentials can be reached from the cache object.
  const entries = new Map<string, SessionCredentials>();
  const inflight = new Map<string, Promise<SessionCredentials>>();

  async function assume(key: string, ref: AccountRef, role: RoleName): Promise<SessionCredentials> {
    try {
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn(ref.awsAccountId, role),
          RoleSessionName: sessionName(caller, randomHex16()),
          ExternalId: ref.externalId,
          DurationSeconds: SESSION_SECONDS,
        }),
      );
      const c = out.Credentials;
      const expiration = c?.Expiration;
      if (
        !c?.AccessKeyId ||
        !c.SecretAccessKey ||
        !c.SessionToken ||
        !(expiration instanceof Date) ||
        Number.isNaN(expiration.getTime()) ||
        expiration.getTime() - clock.now().getTime() <= REFRESH_MARGIN_MS
      ) {
        throw invalidResponse();
      }
      const fresh = new SessionCredentials(
        c.AccessKeyId,
        c.SecretAccessKey,
        c.SessionToken,
        expiration,
      );
      entries.set(key, fresh);
      return fresh;
    } catch (error) {
      entries.delete(key);
      throw toAwsError(error, OPERATION);
    }
  }

  async function get(account: AccountRef, role: RoleName): Promise<SessionCredentials> {
    let key: string;
    let ref: AccountRef;
    try {
      assertRoleAllowed(caller, role);
      ref = checkedAccountRef(account);
      key = `${ref.awsAccountId}:${ref.externalId}:${role}`;
    } catch (error) {
      throw toAwsError(error, OPERATION);
    }

    const cached = entries.get(key);
    if (cached && cached.expiration.getTime() - clock.now().getTime() > REFRESH_MARGIN_MS) {
      return cached;
    }
    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = assume(key, ref, role);
    inflight.set(key, promise);
    const done = () => {
      if (inflight.get(key) === promise) inflight.delete(key);
    };
    promise.then(done, done);
    return promise;
  }

  return { get };
}
