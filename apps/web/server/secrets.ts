// The EPS secrets reach the web app only through this port (R3). No `sst` import: the linked
// resources arrive as environment variables named SST_RESOURCE_<Name>, each a JSON object with a
// `value`. VERIFY (open point 2): the SST v3 format of these variables, and that OpenNext passes
// them to the server function; not checked here. A secret is read when asked for and is never held
// in a module constant; an unreadable one is `undefined`, and the caller fails closed (R16).

export type SecretName =
  | "EpsMerchantId"
  | "EpsStoreId"
  | "EpsUsername"
  | "EpsPassword"
  | "EpsHashKey"
  | "EpsLimitKey"
  | "AuthLimitKey"
  | "OtpHashKey";

export type SecretSource = (name: SecretName) => string | undefined;

export function resourceSecrets(env: Readonly<Record<string, string | undefined>>): SecretSource {
  return (name) => {
    const raw = env[`SST_RESOURCE_${name}`];
    if (typeof raw !== "string") return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const value = (parsed as { value?: unknown }).value;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
}
