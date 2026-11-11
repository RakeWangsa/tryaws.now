// Pure helpers of scripts/smoke-wallet.mjs (WP3-T4 Task 8): the environment of the child servers,
// the BLOCKED texts, the line that wallet.spec.ts prints, and the SQL of the seed. Nothing here
// starts a process or opens a connection.
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

export const APP_ORIGIN = "http://localhost:3000";
export const SMOKE_PORT = 3000;
// The local compose database (docker-compose.yml); a development value, not a secret.
export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";
export const PLAYWRIGHT_VERSION = "1.64.1";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True only for a URL whose host is the machine itself. A socket path or text that is no URL is false. */
export function isLocalDatabaseUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return false;
  if (parsed.searchParams.has("host") || parsed.searchParams.has("hostaddr")) return false;
  return LOCAL_HOSTS.has(parsed.hostname);
}

const DROPPED = /^(AWS_|SST_|TC_|APP_ORIGIN$|NODE_ENV$|DATABASE_URL$)/;

/**
 * The environment of the dev server and of Playwright. Refused (R3, R16): the staging and production
 * stages, and any database that is not local. No AWS credential, SST secret or other stage variable is
 * passed on. Returns { ok: true, env } or { ok: false, reason }; the reason never holds the URL.
 */
export function smokeEnv(env) {
  const stage = env.TC_STAGE;
  if (stage === "staging" || stage === "production") {
    return { ok: false, reason: "TC_STAGE is staging or production: the smoke runs locally only" };
  }
  const url =
    env.DATABASE_URL === undefined || env.DATABASE_URL === ""
      ? LOCAL_DATABASE_URL
      : env.DATABASE_URL;
  if (!isLocalDatabaseUrl(url)) {
    return {
      ok: false,
      reason: "DATABASE_URL is not a local address: the smoke runs locally only",
    };
  }
  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.test(name)) continue;
    child[name] = value;
  }
  return {
    ok: true,
    env: {
      ...child,
      TC_STAGE: "local",
      TC_EPS: "fake",
      APP_ORIGIN,
      NODE_ENV: "development",
      DATABASE_URL: url,
    },
  };
}

const LINE =
  /^WALLET-SMOKE ([a-z]+-[0-9]+) balance=(\S+) ledger=([0-9]+) payments=([0-9]+) noscroll=(true|false)$/;

/** The summary line of one Playwright project, or null for any other line. */
export function parseTopUpLine(line) {
  const match = LINE.exec(typeof line === "string" ? line.trim() : "");
  if (match === null) return null;
  return {
    project: match[1],
    balance: match[2],
    ledger: Number(match[3]),
    payments: Number(match[4]),
    noScroll: match[5] === "true",
  };
}

/** What the runner prints when a step cannot run: a skipped proof is a failed proof (R16, open point 8). */
export function blocked(cause) {
  const head = "smoke-wallet: BLOCKED";
  switch (cause) {
    case "playwright":
      return `${head}: @playwright/test is not installed. Run once, with the network: pnpm add -D -w --save-exact @playwright/test@${PLAYWRIGHT_VERSION}`;
    case "browser":
      return `${head}: no Chromium for Playwright. Run once, with the network: pnpm exec playwright install chromium`;
    case "database":
      return `${head}: the local database does not answer or is not migrated. Run: pnpm db:up && pnpm db:migrate`;
    case "port":
      return `${head}: port ${SMOKE_PORT} cannot be used. Free it, and in a sandbox set sandbox.network.allowLocalBinding: true`;
    default:
      return `${head}: ${String(cause)}`;
  }
}

// ---- the seed -----------------------------------------------------------------------------------

/** A version 7 UUID (the ids of the schema are time-ordered); the seed has no access to the uuid package. */
export function uuidV7(now = Date.now()) {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const PLATFORM_ACCOUNT_TYPES = [
  "gateway_clearing",
  "revenue_aws_base",
  "vat_korea_payable",
  "vat_bd_payable",
  "processing_fee_income",
  "markup_income",
  "refunds",
  "adjustments",
];

/**
 * The statements of the seed, as { text, values }: an active market with known limits and quick
 * amounts, the platform ledger accounts, one verified customer with an empty wallet for each Playwright project, and a third customer
 * with one open payment (for the cross-tenant check). Run as the table
 * owner of the LOCAL database. The market row is made active with the same limits the fixtures use.
 */
export function seedSql(options = {}) {
  const suffix = options.suffix ?? randomBytes(4).toString("hex");
  // One signed-in customer for each Playwright project (their balances must not mix), and a third
  // who owns the payment that the others must not see.
  const people = [
    { id: uuidV7(), sub: `dev-smoke-bn-${suffix}`, project: "bn-360" },
    { id: uuidV7(), sub: `dev-smoke-en-${suffix}`, project: "en-1280" },
  ];
  const other = options.otherCustomerId ?? uuidV7();
  const otherSub = `dev-smoke-other-${suffix}`;
  const otherPayment = options.otherPaymentId ?? uuidV7();

  const statements = [
    {
      text: `insert into markets
               (id, code, currency, gateway, locales, numerals, topup_min_minor, topup_max_minor, quick_amounts, active)
             values ($1, 'BD', 'BDT', 'eps', '{bn,en}', 'beng', 10000, 5000000, '[500,1000,2000]'::jsonb, true)
             on conflict (code) do update set active = true,
               topup_min_minor = excluded.topup_min_minor,
               topup_max_minor = excluded.topup_max_minor,
               quick_amounts = excluded.quick_amounts`,
      values: [uuidV7()],
    },
  ];
  for (const type of PLATFORM_ACCOUNT_TYPES) {
    statements.push({
      text: `insert into ledger_accounts (id, type, customer_id, currency)
             values ($1, '${type}', null, 'BDT')
             on conflict on constraint ledger_accounts_customer_id_type_currency_unique do nothing`,
      values: [uuidV7()],
    });
  }
  for (const [id, who] of [...people.map((p) => [p.id, p.sub]), [other, otherSub]]) {
    statements.push(
      {
        text: `insert into customers (id, cognito_sub, email, market, kyc_status, locale)
               values ($1, $2, $3, 'BD', 'verified', 'bn')`,
        values: [id, who, `${who}@example.test`],
      },
      {
        text: `insert into wallets (id, customer_id, currency) values ($1, $2, 'BDT')
               on conflict (customer_id) do nothing`,
        values: [uuidV7(), id],
      },
      {
        text: `insert into ledger_accounts (id, type, customer_id, currency)
               values ($1, 'customer_wallet', $2, 'BDT')
               on conflict on constraint ledger_accounts_customer_id_type_currency_unique do nothing`,
        values: [uuidV7(), id],
      },
    );
  }
  statements.push({
    text: `insert into payments
             (id, customer_id, gateway, merchant_transaction_id, idempotency_key, amount_minor, currency, status)
           values ($1, $2, 'eps', $3, $4, 100000, 'BDT', 'redirected')`,
    values: [otherPayment, other, randomBytes(16).toString("hex"), `smoke-${suffix}-other-key`],
  });
  const subs = Object.fromEntries(people.map((p) => [p.project, p.sub]));
  return Object.assign(statements, { subs, otherPaymentId: otherPayment });
}
