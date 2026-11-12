"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { destroyCdnCore, setCdnEnabledCore } from "../../../../../server/cdn-actions.ts";
import type { CdnResult } from "../../../../../server/cdn-actions.ts";
import { cdnActionDeps } from "../../../../../server/cdn-deps.ts";
import {
  CDN_CACHE_BEHAVIORS,
  CDN_ORIGIN,
  CDN_PLAN,
  CDN_REFRESH_CERTIFICATE,
  CDN_REMOVE_CERTIFICATE,
  CDN_REPLACE_CERTIFICATE,
  CDN_REQUEST_CERTIFICATE,
  CDN_RESET_CACHE,
  consoleCore,
  type ConsoleSpec,
} from "../../../../../server/console-actions.ts";
import { familyActionDeps } from "../../../../../server/family-deps.ts";

// The thin Server Actions of the CDN page (16.10). Each one checks the origin, calls its core (which
// follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: CdnResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

type Core = (deps: ReturnType<typeof cdnActionDeps>, raw: unknown) => Promise<CdnResult>;

const run =
  (core: Core, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(cdnActionDeps(), pick(form, names)));
  };

export const setCdnEnabledAction = run(setCdnEnabledCore, ["cdnId", "requestId", "enabled"]);
export const destroyCdnAction = run(destroyCdnCore, ["cdnId", "requestId", "confirmName"]);

// WPU-G7: flush the cache. The generic console core uses the flag-reading deps of family-deps.ts.
export async function resetCdnCacheAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await consoleCore(CDN_RESET_CACHE)(familyActionDeps("cdn"), pick(form, ["cdnId", "requestId"])),
  );
}

// WPU-G8: cache behaviour, origin, plan at the next renewal, custom domain and certificate. Each action
// names the fields it reads and no others (R11).
const consoleAction =
  (spec: ConsoleSpec, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(
      await consoleCore(spec)(
        familyActionDeps("cdn"),
        pick(form, ["cdnId", "requestId", ...names]),
      ),
    );
  };

export const setCdnCacheBehaviorsAction = consoleAction(CDN_CACHE_BEHAVIORS, [
  "defaultBehavior",
  "defaultTtl",
  "minTtl",
  "maxTtl",
  "allowedMethods",
  "cachedMethods",
  "cookies",
  "headers",
  "queryStrings",
  "paths",
]);
export const setCdnOriginAction = consoleAction(CDN_ORIGIN, ["originId"]);
export const scheduleCdnPlanAction = consoleAction(CDN_PLAN, ["productId", "cancel"]);
export const requestCdnCertificateAction = consoleAction(CDN_REQUEST_CERTIFICATE, ["domain"]);
export const refreshCdnCertificateAction = consoleAction(CDN_REFRESH_CERTIFICATE, []);

// WPU-G11: remove or replace the certificate. The typed domain is the only extra text field read here;
// the core compares it with the saved one and asks for a fresh sign-in (U10).
export const removeCdnCertificateAction = consoleAction(CDN_REMOVE_CERTIFICATE, ["confirmName"]);
export const replaceCdnCertificateAction = consoleAction(CDN_REPLACE_CERTIFICATE, [
  "domain",
  "confirmName",
]);
