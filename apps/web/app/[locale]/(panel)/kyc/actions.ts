"use server";

import { revalidatePath } from "next/cache";
import { guardAction, kycActionDeps } from "../../../../server/action-deps.ts";
import {
  startKycUploadCore,
  submitKycCore,
  type StartKycResult,
  type SubmitKycResult,
} from "../../../../server/kyc-actions.ts";

// The two Server Actions of /kyc. Both take a plain object that the form component builds; the
// object keys of the uploads are never part of it (the core derives them). The origin check runs
// first, then the core runs R9 (authenticate, authorize, validate, rate limit, execute, audit).

export async function startKycUploadAction(input: unknown): Promise<StartKycResult> {
  if (!(await guardAction())) return { ok: false, error: "forbidden" };
  return startKycUploadCore(await kycActionDeps(), input);
}

export async function submitKycAction(input: unknown): Promise<SubmitKycResult> {
  if (!(await guardAction())) return { ok: false, error: "forbidden" };
  const result = await submitKycCore(await kycActionDeps(), input);
  // The page shows the pending state straight away.
  if (result.ok) revalidatePath("/[locale]/kyc", "page");
  return result;
}
