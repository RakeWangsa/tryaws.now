"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { familyActionDeps } from "../../../../../server/bucket-deps.ts";
import type { FamilyResult } from "../../../../../server/bucket-frame.ts";
import {
  deployContainersCore,
  destroyContainerServiceCore,
} from "../../../../../server/container-actions.ts";

// The thin Server Actions of the container service page (16.10). Each one checks the origin, calls its
// core (which follows R9) and turns the result into a FormState with a fixed key (U6).

function stateOf(result: FamilyResult): FormState {
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: result.approval === true ? `${result.done}:approval` : result.done };
}

type Core = (deps: ReturnType<typeof familyActionDeps>, raw: unknown) => Promise<FamilyResult>;

const run =
  (core: Core, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(await core(familyActionDeps("container_service"), pick(form, names)));
  };

export const deployContainersAction = run(deployContainersCore, [
  "containerId",
  "requestId",
  "image",
  "port",
  "protocol",
  "environment",
  "publicEndpoint",
  "healthCheckPath",
]);
export const destroyContainerServiceAction = run(destroyContainerServiceCore, [
  "containerId",
  "requestId",
  "confirmName",
]);
