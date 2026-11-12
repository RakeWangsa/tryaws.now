"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { familyActionDeps } from "../../../../../server/bucket-deps.ts";
import type { FamilyResult } from "../../../../../server/bucket-frame.ts";
import {
  CONTAINER_ENDPOINT,
  CONTAINER_PLAN,
  CONTAINER_REFRESH_CERTIFICATE,
  CONTAINER_REQUEST_CERTIFICATE,
  consoleCore,
  type ConsoleSpec,
} from "../../../../../server/console-actions.ts";
import {
  deployContainersCore,
  destroyContainerServiceCore,
} from "../../../../../server/container-actions.ts";
import { familyActionDeps as consoleDeps } from "../../../../../server/family-deps.ts";

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

const containerFields = (s: string): string[] => [
  `image${s}`,
  `port${s}`,
  `protocol${s}`,
  `environment${s}`,
  `command${s}`,
];
export const deployContainersAction = run(deployContainersCore, [
  "containerId",
  "requestId",
  ...containerFields(""),
  ...containerFields("2"),
  ...containerFields("3"),
  "publicEndpoint",
  "endpointContainer",
  "endpointPort",
  "healthCheckPath",
]);
export const destroyContainerServiceAction = run(destroyContainerServiceCore, [
  "containerId",
  "requestId",
  "confirmName",
]);

// WPU-G8: the generic console core (R9 order, R7 key from the request id, R8 ownership) with the
// flag-reading deps of family-deps.ts. Each action names the fields it reads and no others (R11).
const consoleAction =
  (spec: ConsoleSpec, names: readonly string[]) =>
  async (_previous: FormState, form: FormData): Promise<FormState> => {
    if (!(await guardAction())) return { error: "unauthenticated" };
    return stateOf(
      await consoleCore(spec)(
        consoleDeps("container_service"),
        pick(form, ["containerId", "requestId", ...names]),
      ),
    );
  };

export const scheduleContainerPlanAction = consoleAction(CONTAINER_PLAN, ["productId", "cancel"]);
export const requestContainerCertificateAction = consoleAction(CONTAINER_REQUEST_CERTIFICATE, [
  "domain",
]);
export const refreshContainerCertificateAction = consoleAction(CONTAINER_REFRESH_CERTIFICATE, []);
export const setContainerEndpointAction = consoleAction(CONTAINER_ENDPOINT, [
  "container",
  "port",
  "healthCheckPath",
  "remove",
]);
