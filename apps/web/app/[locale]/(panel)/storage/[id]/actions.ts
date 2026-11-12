"use server";

import { guardAction } from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import {
  deleteAccessKeyCore,
  destroyBucketCore,
  setBucketAccessCore,
} from "../../../../../server/bucket-actions.ts";
import { familyActionDeps } from "../../../../../server/bucket-deps.ts";
import {
  BUCKET_INSTANCE_ACCESS,
  BUCKET_VERSIONING,
  consoleCore,
} from "../../../../../server/console-actions.ts";
import { familyActionDeps as consoleDeps } from "../../../../../server/family-deps.ts";
import type { FamilyResult } from "../../../../../server/bucket-frame.ts";

// The thin Server Actions of the bucket page (16.10). Each one checks the origin, calls its core
// (which follows R9) and turns the result into a FormState with a fixed key (U6).

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
    return stateOf(await core(familyActionDeps("bucket"), pick(form, names)));
  };

export const setBucketAccessAction = run(setBucketAccessCore, [
  "bucketId",
  "requestId",
  "mode",
  "confirmText",
]);
export const deleteAccessKeyAction = run(deleteAccessKeyCore, [
  "bucketId",
  "requestId",
  "accessKeyId",
  "confirmName",
]);
export const destroyBucketAction = run(destroyBucketCore, ["bucketId", "requestId", "confirmName"]);

// WPU-G7: versioning on or suspended. The generic console core uses the flag-reading deps of family-deps.ts.
export async function setBucketVersioningAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await consoleCore(BUCKET_VERSIONING)(
      consoleDeps("bucket"),
      pick(form, ["bucketId", "requestId", "versioning"]),
    ),
  );
}

// WPU-G9: open or close the bucket to one server of the customer.
export async function setBucketInstanceAccessAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "unauthenticated" };
  return stateOf(
    await consoleCore(BUCKET_INSTANCE_ACCESS)(
      consoleDeps("bucket"),
      pick(form, ["bucketId", "requestId", "instanceId", "access"]),
    ),
  );
}
