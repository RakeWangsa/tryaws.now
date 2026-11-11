"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { destroyCdnCore, setCdnEnabledCore } from "../../../../../server/cdn-actions.ts";
import type { CdnResult } from "../../../../../server/cdn-actions.ts";
import { cdnActionDeps } from "../../../../../server/cdn-deps.ts";

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
