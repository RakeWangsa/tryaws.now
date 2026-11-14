"use server";

import {
  guardAction,
  settingsActionDeps,
  totpActionDeps,
} from "../../../../../server/action-deps.ts";
import { pick } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { changePasswordCore } from "../../../../../server/settings-actions.ts";
import {
  confirmTotpCore,
  disableTotpCore,
  startTotpCore,
} from "../../../../../server/totp-actions.ts";
import { qrPathOf } from "../../../../../server/totp-qr.ts";

// The Server Action of /settings/security. The three passwords are read from the form, passed to the
// core and dropped: no state, no log and no answer ever holds one (R14). A failure leaves as a public
// error key and the field codes.
export async function changePasswordAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await changePasswordCore(
    await settingsActionDeps(),
    pick(form, ["currentPassword", "newPassword", "confirmPassword"]),
  );
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: "changed" };
}

// WPU-X11: the authenticator (TOTP). The secret leaves only in the answer of startTotpAction, once, to the
// form that asked (U9: a Server Action response, never a cached render); it is not stored or logged.
export interface TotpFormState extends FormState {
  readonly secret?: string;
  readonly otpauthUri?: string;
  /** The QR code of otpauthUri as path data of one SVG path (server/totp-qr.ts), with its size. */
  readonly qr?: { readonly size: number; readonly margin: number; readonly d: string };
}

// The action takes no field: useActionState passes the previous state and the form, which are not read.
export async function startTotpAction(): Promise<TotpFormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await startTotpCore(await totpActionDeps());
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  // The QR code is made here, on the server, from the URI of this answer only (U9).
  const qr = qrPathOf(result.otpauthUri);
  return { done: "started", secret: result.secret, otpauthUri: result.otpauthUri, qr };
}

export async function confirmTotpAction(
  _previous: TotpFormState,
  form: FormData,
): Promise<TotpFormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await confirmTotpCore(await totpActionDeps(), pick(form, ["code"]));
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: "enabled" };
}

export async function disableTotpAction(): Promise<FormState> {
  if (!(await guardAction())) return { error: "forbidden" };
  const result = await disableTotpCore(await totpActionDeps());
  if (!result.ok) {
    return { error: result.error, ...(result.fields ? { fields: result.fields } : {}) };
  }
  return { done: "disabled" };
}
