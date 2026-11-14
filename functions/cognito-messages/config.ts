// WPU-X12 round 3: the configuration of the two Cognito triggers, read from SSM on a cold start.
// The id of CustomerSignUpClient and the id of the customer pool are written by the stack into two
// String parameters (ids, not secrets; infra/stacks/auth.ts). They are not environment values: a
// function that carried them would depend on the client and the pool, and the pool depends on the
// function (its trigger), which is a cycle. The parameter NAMES are fixed strings and reach the function
// as environment values. A successful read is kept for the life of the container; a failed, partial or
// malformed read gives null (every guarded decision refuses, R16) and is not kept, so the next call
// reads again. No value or error text is logged or returned (R14).
//
// Round 4: a kept id can go stale (the client is replaced, so its id changes, and a warm container
// would refuse the new client until it is recycled). A decision that sees a client id other than the
// kept one asks for one more read, at most one per minute per container; a failed or malformed re-read
// keeps the old answer, so the new client is refused until a read works (never allowed, R16).

export const SIGN_UP_CLIENT_PARAMETER_ENV = "SIGN_UP_CLIENT_PARAMETER";
export const CUSTOMER_POOL_PARAMETER_ENV = "CUSTOMER_POOL_PARAMETER";

/** At most one re-read of a stale id per container in this many milliseconds. */
export const REREAD_MIN_INTERVAL_MS = 60_000;

export interface GuardConfig {
  readonly signUpClientId: string;
  readonly customerPoolId: string;
}

/** Reads String parameters by name; the answer maps each found name to its value. */
export type ReadParameters = (
  names: readonly string[],
) => Promise<Readonly<Record<string, string | undefined>>>;

/** `seenClientId`: the client id of the event being decided, so a stale kept id can be refreshed. */
export type LoadGuardConfig = (seenClientId?: string) => Promise<GuardConfig | null>;

// The patterns of packages/auth/config.ts (CLIENT_ID, POOL_ID) and of an SSM parameter name.
const CLIENT_ID = /^[A-Za-z0-9]{10,64}$/;
const POOL_ID = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/;
const PARAMETER_NAME = /^\/[A-Za-z0-9_.\-/]{1,1000}$/;

export function guardConfigLoader(
  env: Readonly<Record<string, string | undefined>>,
  read: ReadParameters,
  now: () => number = Date.now,
): LoadGuardConfig {
  const clientName = env[SIGN_UP_CLIENT_PARAMETER_ENV];
  const poolName = env[CUSTOMER_POOL_PARAMETER_ENV];
  const named =
    typeof clientName === "string" &&
    PARAMETER_NAME.test(clientName) &&
    typeof poolName === "string" &&
    PARAMETER_NAME.test(poolName);

  let kept: Promise<GuardConfig | null> | undefined;
  // The time of the last re-read of a stale id, the cap of REREAD_MIN_INTERVAL_MS.
  let lastReread: number | undefined;

  async function fetchOnce(): Promise<GuardConfig | null> {
    if (!named) return null;
    try {
      const values = await read([clientName, poolName]);
      const signUpClientId = values[clientName];
      const customerPoolId = values[poolName];
      if (
        typeof signUpClientId !== "string" ||
        !CLIENT_ID.test(signUpClientId) ||
        typeof customerPoolId !== "string" ||
        !POOL_ID.test(customerPoolId)
      ) {
        return null;
      }
      return { signUpClientId, customerPoolId };
    } catch {
      return null;
    }
  }

  return async (seenClientId) => {
    if (kept === undefined) {
      // The first read starts the minute of the cap: a cold container does not read twice for one event.
      lastReread = now();
      const started = fetchOnce();
      kept = started;
      // Only a good answer stays; a refusal is read again next time.
      void started.then((config) => {
        if (config === null && kept === started) kept = undefined;
      });
    }
    const current = await kept;
    if (current === null || seenClientId === undefined || seenClientId === current.signUpClientId) {
      return current;
    }
    // A client id other than the kept one: the client may have been replaced. One re-read a minute.
    const at = now();
    if (lastReread !== undefined && at - lastReread < REREAD_MIN_INTERVAL_MS) return current;
    lastReread = at;
    const fresh = await fetchOnce();
    if (fresh === null) return current;
    kept = Promise.resolve(fresh);
    return fresh;
  };
}
