import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import {
  adminAuthConfigFromEnv,
  cognitoAdminSignInPort,
  configureAdminAuth,
  createAccessTokenVerifier,
  requireAdmin,
  signInAdmin,
  type AdminAuthConfig,
  type AdminSessionDeps,
  type AdminSignInPort,
} from "@tc/auth";
import {
  adminRepos,
  consumeRateLimits,
  lookupAdminBySub,
  recordAdminAccess,
  withTx,
  type AdminActor,
  type AdminRepos,
} from "@tc/db";
import { notifyWaitlist, postTransaction } from "@tc/core";
import type { OperationQueue } from "@tc/core";
import type { Tx } from "@tc/db";
import { adminGate } from "./gate.ts";
import type { MoneyFlowDeps } from "./money-flow.ts";
import type { CustomerFlowDeps } from "./customer-flow.ts";
import type { CapacityFlowDeps } from "./capacity-flow.ts";
import type { OpsFlowDeps } from "./ops-flow.ts";
import { unavailableKycStore, type KycDocumentDeps } from "./kyc-documents.ts";
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

// The decisions of /customers (ops and superadmin act) and the document viewer (support reads too).
// 30 decisions and 60 document views for each admin in 10 minutes: a review session needs many, a
// script a lot more.
const CUSTOMER_ACTION_LIMIT = 30;
const DOCUMENT_VIEW_LIMIT = 60;

const adminLimiter =
  (action: string, limit: number) =>
  (actor: AdminActor, now: Date): Promise<boolean> =>
    withTx(async (tx) => {
      const decision = await consumeRateLimits(
        tx,
        [
          {
            kind: "ip",
            subject: subjectOf(actor.adminId),
            action,
            limit,
            windowSeconds: SIGN_IN_WINDOW_SECONDS,
          },
        ],
        now,
      );
      return decision.allowed;
    });

const runAsAdmin = <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>): Promise<T> =>
  withTx((tx) => fn(adminRepos(tx, actor)));

export function customerFlowDeps(): CustomerFlowDeps {
  ensureAdminAuth();
  return {
    authorize: () => requireAdmin(["ops", "superadmin"]),
    limiter: adminLimiter("admin_customer_action", CUSTOMER_ACTION_LIMIT),
    run: runAsAdmin,
    clock: { now: () => new Date() },
  };
}

// The money actions of /wallets and /payments (WP8-T3): 30 for each admin in 10 minutes, the roles
// are asked for by each kind, and every posting goes through postTransaction of @tc/core (R5).
const MONEY_ACTION_LIMIT = 30;

export function moneyFlowDeps(): MoneyFlowDeps {
  ensureAdminAuth();
  return {
    authorize: (roles) => requireAdmin([...roles]),
    limiter: adminLimiter("admin_money_action", MONEY_ACTION_LIMIT),
    run: runAsAdmin,
    post: postTransaction,
    clock: { now: () => new Date() },
  };
}

// Until the S3 presigner is wired (a manual VERIFY of WP8-T2) the store refuses every view.
export function kycDocumentDeps(): KycDocumentDeps {
  ensureAdminAuth();
  return {
    authorize: () => requireAdmin(["support", "ops", "superadmin"]),
    limiter: adminLimiter("admin_kyc_document", DOCUMENT_VIEW_LIMIT),
    run: runAsAdmin,
    store: unavailableKycStore,
    clock: { now: () => new Date() },
  };
}

// The decisions of /operations and the actions of /capacity (WP8-T5): ops and superadmin, 30 for each
// admin in 10 minutes. The admin app has no queue client (R1): the send is refused here on purpose,
// sendAfterCommit answers false and the scheduler sends the message again from the row (3.4).
const OPS_ACTION_LIMIT = 30;
const SCHEDULER_ONLY_QUEUE: OperationQueue = {
  async send() {
    throw new Error("admin: no queue client in the admin tier");
  },
};

export function opsFlowDeps(): OpsFlowDeps {
  ensureAdminAuth();
  return {
    authorize: (roles) => requireAdmin([...roles]),
    limiter: adminLimiter("admin_ops_action", OPS_ACTION_LIMIT),
    run: runAsAdmin,
    queue: SCHEDULER_ONLY_QUEUE,
    clock: { now: () => new Date() },
  };
}

export function capacityFlowDeps(): CapacityFlowDeps {
  ensureAdminAuth();
  return {
    authorize: (roles) => requireAdmin([...roles]),
    limiter: adminLimiter("admin_capacity_action", OPS_ACTION_LIMIT),
    run: (actor, fn) => withTx((tx: Tx) => fn(adminRepos(tx, actor), tx)),
    // Fails closed: the template waitlist_capacity_available is not registered in @tc/notify yet, so the
    // whole action rolls back and no entry is marked notified without a message (R16).
    notifyWaitlist: (tx, actor, input) =>
      notifyWaitlist(tx, actor, input, async () => {
        throw new Error("waitlist: no notifier template");
      }),
    clock: { now: () => new Date() },
  };
}

// The reads of the customer screens, in one transaction of the admin.
export const readAsAdmin = runAsAdmin;
