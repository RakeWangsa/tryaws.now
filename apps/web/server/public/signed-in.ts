import { currentCustomer } from "@tc/auth";
import { cache } from "react";
import { getRuntime } from "../runtime.ts";

// Whether the visitor of a public page has a valid customer session (WPU-N1), so that the menu shows
// "Console" instead of "Log in". Only a boolean leaves this file: no name, no id, no e-mail enters the
// page (the public pages are not customer pages). The public pages are already rendered per request (the
// nonce of the proxy), so reading the cookie costs no caching; the answer is `cache`d per request.
// Fail closed (R16): any failure is "not signed in", which shows the login link and nothing else.

export async function signedInWith(
  start: () => Promise<unknown>,
  current: () => Promise<{ ok: boolean }>,
): Promise<boolean> {
  try {
    await start();
    return (await current()).ok === true;
  } catch {
    return false;
  }
}

export const publicSignedIn = cache((): Promise<boolean> =>
  signedInWith(getRuntime, currentCustomer),
);
