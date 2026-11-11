import { LightsailClient } from "@aws-sdk/client-lightsail";
import type { Clock } from "@tc/core";
import { createCredentialCache, createStsClient } from "./credentials";
import { AwsError, mapErrors } from "./errors";
import {
  CALLER_ROLES,
  LIGHTSAIL_REGIONS,
  LIGHTSAIL_ROLES,
  assertRoleAllowed,
  checkedAccountRef,
  type AccountRef,
  type Caller,
  type LightsailRegion,
  type LightsailRole,
  type RoleOf,
} from "./roles";
import { clientSettings } from "./settings";
import type { AwsRequestHandler } from "./types";

export interface CreateAwsAccessOptions<C extends Caller> {
  caller: C;
  clock?: Clock;
}

/** Not exported from the package: the tests pass a fake transport used for STS and every client. */
export interface InternalAwsAccessOptions<C extends Caller> extends CreateAwsAccessOptions<C> {
  requestHandler?: AwsRequestHandler;
}

export interface AwsAccess<C extends Caller> {
  readonly caller: C;
  lightsail(
    account: AccountRef,
    region: LightsailRegion,
    role: Extract<RoleOf<C>, LightsailRole>,
  ): LightsailClient;
}

function roleNotAllowed(): AwsError {
  return new AwsError({ code: "forbidden", retryable: true, reason: "role_not_allowed" });
}

/** The public entry: only `caller` and `clock` are read, whatever else the object holds. */
export function createAwsAccess<C extends Caller>(
  options: CreateAwsAccessOptions<C>,
): AwsAccess<C> {
  return createAwsAccessInternal({ caller: options.caller, clock: options.clock });
}

/** For tests (and nothing else): the same, with a fake transport. */
export function createAwsAccessInternal<C extends Caller>(
  options: InternalAwsAccessOptions<C>,
): AwsAccess<C> {
  const { caller, requestHandler } = options;
  // Fail closed before anything is created (Object.hasOwn: no "__proto__").
  if (typeof caller !== "string" || !Object.hasOwn(CALLER_ROLES, caller)) throw roleNotAllowed();
  const clock = options.clock ?? { now: () => new Date() };
  const cache = createCredentialCache({
    sts: createStsClient(requestHandler),
    caller,
    clock,
  });
  const clients = new Map<string, LightsailClient>();

  function lightsail(
    account: AccountRef,
    region: LightsailRegion,
    role: Extract<RoleOf<C>, LightsailRole>,
  ): LightsailClient {
    assertRoleAllowed(caller, role);
    if (!(LIGHTSAIL_ROLES as readonly string[]).includes(role)) throw roleNotAllowed();
    if (!(LIGHTSAIL_REGIONS as readonly string[]).includes(region)) {
      throw new AwsError({ code: "internal", retryable: true, reason: "region_not_allowed" });
    }
    const checked = checkedAccountRef(account);

    const key = JSON.stringify([checked.awsAccountId, checked.externalId, role, region]);
    const existing = clients.get(key);
    if (existing) return existing;

    // No `logger`: the SDK's logger would write the raw AWS error text (R14).
    const client = new LightsailClient({
      region,
      // `memoized`: the SDK must not keep a copy of the session, the cache is the only layer.
      credentials: Object.assign(() => cache.get(checked, role), { memoized: true }),
      ...clientSettings(role),
      ...(requestHandler ? { requestHandler } : {}),
    });
    mapErrors(client, (error) => {
      // AWS rejected the session: drop it so that the next call assumes the role again.
      if (
        (error.code === "unauthenticated" || error.code === "forbidden") &&
        error.operation !== "AssumeRole"
      ) {
        cache.invalidate(checked, role);
      }
    });
    clients.set(key, client);
    return client;
  }

  return Object.freeze({ caller, lightsail });
}
