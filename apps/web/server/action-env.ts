import { requireCustomer } from "@tc/auth";
import { DEFAULT_LOCALE, isLocale } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { headers } from "next/headers";
import { writeLog } from "./log.ts";
import { requestId } from "./request.ts";
import { getRuntime } from "./runtime.ts";
import type { ActionEnv, RecheckDeps, StartDeps } from "./topup-core.ts";
import { loadPayment, loadRange } from "./topup-view.ts";

// The real dependencies of the top-up Server Actions. Everything a test replaces is here; the logic
// is in topup-core.ts.

async function currentLocale(): Promise<Locale> {
  try {
    const found = await getLocale();
    return isLocale(found) ? found : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function actionEnv(): Promise<ActionEnv> {
  const [runtime, requestHeaders, locale] = await Promise.all([
    getRuntime(),
    headers(),
    currentLocale(),
  ]);
  return { config: runtime.config, eps: runtime.eps, headers: requestHeaders, locale };
}

export function startDeps(redirect: (to: string) => never): StartDeps {
  return {
    authenticate: requireCustomer,
    env: actionEnv,
    loadRange,
    redirect,
    // 128 bits from the platform's CSPRNG; the shape matches ^[A-Za-z0-9_-]{8,128}$.
    newKey: () => crypto.randomUUID(),
    newRequestId: requestId,
    log: writeLog,
  };
}

export const recheckDeps: RecheckDeps = {
  authenticate: requireCustomer,
  env: actionEnv,
  readRow: async (session, paymentId) => {
    const found = await loadPayment(session, paymentId);
    return found === null ? null : { status: found.payment.status };
  },
  log: writeLog,
};
