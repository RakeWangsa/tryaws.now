// The five EPS secrets reach this function only through this port (R3). The real source reads SST's
// linked Resource (index.ts, open point 3); tests pass a plain object. Errors name the secret, never its value.
export const EPS_SECRET_NAMES = [
  "EpsMerchantId",
  "EpsStoreId",
  "EpsUsername",
  "EpsPassword",
  "EpsHashKey",
] as const;

export type EpsSecretName = (typeof EPS_SECRET_NAMES)[number];

export interface SecretSource {
  get(name: EpsSecretName): string;
}

export async function sstSecrets(
  load: () => Promise<Record<string, { value: string } | undefined>>,
): Promise<SecretSource> {
  const loaded = await load();
  const values = new Map<EpsSecretName, string>();
  for (const name of EPS_SECRET_NAMES) {
    const value = loaded[name]?.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`sweeper: secret ${name} is missing`);
    }
    values.set(name, value);
  }
  return {
    get(name) {
      const value = values.get(name);
      if (value === undefined) throw new Error(`sweeper: secret ${name} is missing`);
      return value;
    },
  };
}
