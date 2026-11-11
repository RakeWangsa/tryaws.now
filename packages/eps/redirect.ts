/**
 * VERIFY (open point 6): hosts where RedirectURL may land the customer. Anything else is never
 * returned. The one list: the gateway client (http.ts) and the CSP form-action of the apps read it.
 */
export const EPS_REDIRECT_HOSTS: readonly string[] = Object.freeze([
  "pg.eps.com.bd",
  "pg.eps.test",
]);

// A longer text is not a redirect of EPS; the bound keeps a hostile value from being parsed at all.
const MAX_REDIRECT_LENGTH = 4096;

/**
 * The URL itself, normalised, when it is https, carries no credentials and no port, and its host is
 * on the list; null for everything else (a non-string, a relative or protocol-relative URL, another
 * scheme, another host). The caller redirects to the returned text and to nothing else.
 */
export function checkGatewayRedirect(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_REDIRECT_LENGTH) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "")
      return null;
    return EPS_REDIRECT_HOSTS.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The origins a page may post a form to (CSP form-action): the real host only; the .test host is not included. */
export function gatewayFormOrigins(): string[] {
  return EPS_REDIRECT_HOSTS.filter((host) => !host.endsWith(".test")).map(
    (host) => `https://${host}`,
  );
}
