import { NOT_CONFIGURED } from "@tc/db/links";

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

// WPU-Z11: the value a person stores for an EPS secret before the merchant account exists (final review M3:
// the one constant NOT_CONFIGURED of @tc/db/links; scripts/golive/stage-secrets.sh writes it for each EPS
// value left empty). One of the five on it means EPS is not configured: the job then asks EPS nothing (R6, R16).
export { NOT_CONFIGURED };

export function epsConfigured(secrets: SecretSource): boolean {
  return EPS_SECRET_NAMES.every((name) => secrets.get(name) !== NOT_CONFIGURED);
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
