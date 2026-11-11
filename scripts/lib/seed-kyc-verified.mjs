// WP2-T4: marks one test customer as KYC verified, on staging only, until approveKyc exists
// (WP8-T2). The logic is here so that it runs in a test without a database; scripts/seed-kyc-verified.mjs
// is the thin runner. It writes customers.kyc_status and nothing else, and it prints no e-mail
// address (R14). Run it as the table owner: no application role may write kyc_status.

// An allow-list, not a "not production" test: every other stage name, a mis-spelt production
// stage included, is refused (R16).
export const SEED_STAGES = Object.freeze(["staging", "local"]);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Throws unless the stage is on the list. */
export function assertSeedStage(stage) {
  if (typeof stage !== "string" || !SEED_STAGES.includes(stage)) {
    throw new Error("seed-kyc-verified: refused. This command runs on staging only.");
  }
}

/**
 * @param {{ stage: unknown, email: unknown, query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }} input
 * @returns {Promise<{ updated: number }>}
 */
export async function markKycVerified({ stage, email, query }) {
  assertSeedStage(stage);
  if (typeof email !== "string" || !EMAIL.test(email)) {
    throw new Error("seed-kyc-verified: --email must be the e-mail address of a test customer.");
  }
  const result = await query(
    `update customers set kyc_status = 'verified'
       where lower(email) = lower($1) and kyc_status <> 'verified'
       returning id`,
    [email],
  );
  return { updated: result.rows.length };
}

/** `--stage <name> --email <address>`; the stage falls back to the STAGE variable. */
export function parseArgs(argv, env) {
  const out = { stage: env.STAGE, email: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--stage") out.stage = argv[(i += 1)];
    else if (argv[i] === "--email") out.email = argv[(i += 1)];
  }
  return out;
}
