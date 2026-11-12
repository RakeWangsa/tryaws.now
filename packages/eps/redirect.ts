/**
 * VERIFY (open point 6): hosts where RedirectURL may land the customer. Anything else is never
 * returned. The one list: the gateway client (http.ts) and the CSP form-action of the apps read it.
 */
export const EPS_REDIRECT_HOSTS: readonly string[] = Object.freeze(["pg.eps.com.bd"]);

/**
 * WPU-D3 (audit C.7): the host of the in-memory EPS and of the tests. It is never on the production list:
 * it is accepted only when the caller says the stage is not production (`allowTestHosts`), which comes from
 * the configuration (a fake EPS, or the sandbox mode of the gateway client), never from the answer.
 */
export const EPS_TEST_REDIRECT_HOSTS: readonly string[] = Object.freeze(["pg.eps.test"]);

// A longer text is not a redirect of EPS; the bound keeps a hostile value from being parsed at all.
const MAX_REDIRECT_LENGTH = 4096;

/**
 * The URL itself, normalised, when it is https, carries no credentials and no port, and its host is
 * on the list; null for everything else (a non-string, a relative or protocol-relative URL, another
 * scheme, another host). The caller redirects to the returned text and to nothing else.
 */
export function checkGatewayRedirect(
  url: unknown,
  options: { readonly allowTestHosts?: boolean } = {},
): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_REDIRECT_LENGTH) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "")
      return null;
    const allowed =
      EPS_REDIRECT_HOSTS.includes(u.hostname) ||
      (options.allowTestHosts === true && EPS_TEST_REDIRECT_HOSTS.includes(u.hostname));
    return allowed ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The origins a page may post a form to (CSP form-action): the real host only; the .test host is not included. */
export function gatewayFormOrigins(): string[] {
  return EPS_REDIRECT_HOSTS.map((host) => `https://${host}`);
}
