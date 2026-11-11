import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import {
  adminAuthConfigFromEnv,
  cognitoAdminSignInPort,
  configureAdminAuth,
  createAccessTokenVerifier,
  signInAdmin,
  type AdminAuthConfig,
  type AdminSessionDeps,
  type AdminSignInPort,
} from "@tc/auth";
import { consumeRateLimits, lookupAdminBySub, recordAdminAccess, withTx } from "@tc/db";
import { adminGate } from "./gate.ts";
import { makeSignIn, makeSignOut, type SignInDeps } from "./sign-in.ts";

// The composition of the operator app (the pattern of the web app: one module that builds the
// dependencies of the packages from the environment). Server code only. The only place of this app
// that reads process.env for the sign-in, and the only place that touches the database.

// 10 attempts for each address in 10 minutes; a person who mistypes a code needs a few, a script a lot.
const SIGN_IN_LIMIT = 10;
const SIGN_IN_WINDOW_SECONDS = 600;
const RATE_KEY = "tc-admin-ip-v1";

let config: AdminAuthConfig | null = null;
let sessionDeps: AdminSessionDeps | null = null;
let port: AdminSignInPort | null = null;

function adminConfig(): AdminAuthConfig {
  // Throws a TypeError with fixed text when the environment is wrong: the app refuses (R16).
  config ??= adminAuthConfigFromEnv(process.env);
  return config;
}

function sessionDepsOnce(): AdminSessionDeps {
  sessionDeps ??= {
    verifier: createAccessTokenVerifier(adminConfig().admin),
    lookup: (sub) => withTx((tx) => lookupAdminBySub(tx, sub)),
    allowlist: adminConfig().allowlist,
  };
  return sessionDeps;
}

// Called by every page and action before requireAdmin. Idempotent.
let configured = false;
export function ensureAdminAuth(): void {
  if (configured) return;
  const cfg = adminConfig();
  configureAdminAuth({
    config: cfg,
    readRequest: async () => {
      const h = await headers();
      return {
        cookieHeader: h.get("cookie"),
        viewerAddress: h.get("cloudfront-viewer-address"),
        userAgent: h.get("user-agent"),
      };
    },
    deps: { verifier: sessionDepsOnce().verifier, lookup: sessionDepsOnce().lookup },
  });
  configured = true;
}

export const viewerAddressOf = async (): Promise<string | null> =>
  (await headers()).get("cloudfront-viewer-address");
export const userAgentOf = async (): Promise<string | null> => (await headers()).get("user-agent");

const subjectOf = (ip: string): string =>
  createHmac("sha256", RATE_KEY).update(ip).digest("hex").slice(0, 32);

const audit: SignInDeps["audit"] = (entry) =>
  withTx((tx) =>
    recordAdminAccess(tx, {
      action: "admin.sign_in",
      ...entry,
    }),
  );

export function signInDeps(): SignInDeps {
  const deps = sessionDepsOnce();
  port ??= cognitoAdminSignInPort(adminConfig().admin);
  const usedPort = port;
  return {
    allowed: (viewer) => adminGate(viewer, process.env),
    signIn: (input) => signInAdmin(usedPort, deps, input),
    limiter: (ip, now) =>
      withTx(async (tx) => {
        const decision = await consumeRateLimits(
          tx,
          [
            {
              kind: "ip",
              subject: subjectOf(ip),
              action: "admin_sign_in",
              limit: SIGN_IN_LIMIT,
              windowSeconds: SIGN_IN_WINDOW_SECONDS,
            },
          ],
          now,
        );
        return decision.allowed;
      }),
    audit,
    clock: { now: () => new Date() },
  };
}

export const signIn = () => makeSignIn(signInDeps());
export const signOutAudit = () =>
  makeSignOut({
    audit: (entry) => withTx((tx) => recordAdminAccess(tx, { action: "admin.sign_out", ...entry })),
  });
