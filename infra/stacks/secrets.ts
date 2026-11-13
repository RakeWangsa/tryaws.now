// WP0-T2/T3: SST secrets (R3). Only declarations: a value is set by a person with
// `npx sst secret set <Name> <value> --stage <stage>` in their own terminal. Nothing in this
// repository reads, prints or sets a value, and no function receives a secret it does not use
// (the link lists are in workers.ts and web.ts).
//
// NOT TYPE-CHECKED, see network.ts.
import {
  ALL_SECRETS,
  DB_PASSWORD_SECRET,
  FIRST_ADMIN_SUB_SECRET,
  OPTIONAL_SECRET_PLACEHOLDER,
  type SecretName,
} from "../lib/functions";

export function secrets() {
  // VERIFY: a sst.Secret without a value fails the deploy with a message that names the secret
  // (fail closed, R16); no placeholder is passed on purpose, except for the optional FirstAdminSub below.
  const app = Object.fromEntries(ALL_SECRETS.map((name) => [name, new sst.Secret(name)])) as Record<
    SecretName,
    sst.Secret
  >;
  const db = Object.fromEntries(
    Object.entries(DB_PASSWORD_SECRET).map(([role, name]) => [role, new sst.Secret(name)]),
  ) as Record<keyof typeof DB_PASSWORD_SECRET, sst.Secret>;
  // WPU-Z18: the one optional secret, with a placeholder that is not a value: the Cognito `sub` of the
  // first superadmin, set only after that admin exists in the admin pool (docs/runbooks/go-live.md). The
  // placeholder lets every deploy before that run; the migrator reads it as "no secret" and writes
  // nothing. Linked to the migrator only (workers.ts linksOf).
  const firstAdminSub = new sst.Secret(FIRST_ADMIN_SUB_SECRET, OPTIONAL_SECRET_PLACEHOLDER);
  return { app, db, firstAdminSub };
}

export type Secrets = ReturnType<typeof secrets>;
