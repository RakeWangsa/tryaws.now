<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "15. Security gate before launch". Change the plan, then run pnpm spec:split. -->

## 15. Security gate before launch

- [ ] Web and admin function roles have no `sts:AssumeRole` permission (checked in IAM and by a test that tries it).
- [ ] RDS has no public endpoint; security group allows only the proxy; TLS is forced.
- [ ] No secret in the repo history or client bundles (secret scan in CI). After the Playwright P0 run a script searches the staging log groups for the test password, tokens, document number, full phone and email and finds none (R14).
- [ ] Every customer endpoint has a passing cross-tenant test.
- [ ] EPS: replay, forged redirect, amount mismatch and double callback tests pass.
- [ ] Ledger: balance check job reports zero differences; no negative wallet.
- [ ] Rate limits active on sign-in, OTP, top-up and order endpoints (WAF and application).
- [ ] Security headers: CSP with nonces, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, `Referrer-Policy`.
- [ ] Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`; Server Actions accept only same-origin requests.
- [ ] Uploads: size and type limits enforced by the presigned policy; bucket is private.
- [ ] Admin: separate pool, MFA required, IP allowlist enforced, all actions audited. A direct request to the Lambda function URL of `web` or `admin` returns 403.
- [ ] Isolation test passes in each launch Region.
- [ ] SCPs attached to the pool OU and `tc-dns`; the provisioner role cannot use a denied action.
- [ ] CloudTrail and GuardDuty on in every account; dead-letter, 5xx and reconciliation alarms deliver to on-call.
- [ ] Database restore from a point-in-time backup tested once.
- [ ] `pnpm audit` shows no high or critical issue.
- [ ] Each pool account has a monitored security alternate contact for AWS abuse notices, and the abuse runbook (suspend within 24 hours) is written.
- [ ] No page requests a third-party origin: fonts, scripts, styles and images are self-hosted. The only cross-origin traffic from the browser is the KYC upload to the platform's own bucket and the navigation to EPS.
- [ ] No file from the mockup's `assets/js`, `assets/php` or `order-form` folders is in a build output, and `design/mockup/` is excluded from every build.
- [ ] No page, API response, email or SMS that a customer can see contains an AWS account id, an ARN, a pool account name, an internal AWS resource name or raw AWS error text (rule U6). Exceptions: the names and addresses that rule U6 allows because the customer needs them (the bucket name, the default domain of a container service, and the endpoints of databases and distributions).
- [ ] No developer machine and no Claude Code session holds credentials for `tc-platform`, the management account or a customer pool account. Production is deployed only by the CI role after approval.
- [ ] Shell and template characters in every free-text field reach no AWS name, tag or user data (R11).
- [ ] With EPS verify, the KYC lookup or capacity stubbed to fail, the action is refused (R16).
- [ ] An absolute or `//` value of `next` is ignored (U12); a flag-off family returns `flag_off` from `placeOrder` (R12).

