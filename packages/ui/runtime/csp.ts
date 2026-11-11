// Content-Security-Policy of both apps (U4). The nonce is made per request by the middleware;
// `strict-dynamic` lets the nonce scripts of Next.js load their chunks. No `'unsafe-inline'` in
// `script-src`, ever.

export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only" as const;
export const CSP_ENFORCED_HEADER = "Content-Security-Policy" as const;
export const CSP_REPORT_PATH = "/api/csp-report" as const;

export function createNonce(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  return btoa(String.fromCharCode(...randomBytes(16)));
}

const NONCE_FORMAT = /^[A-Za-z0-9+/]+={0,2}$/;

export function buildCsp(o: { nonce: string; dev: boolean }): string {
  if (!NONCE_FORMAT.test(o.nonce)) {
    throw new RangeError("nonce must be base64");
  }
  const { nonce, dev } = o;
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp",
  ];
  return directives.join("; ");
}
