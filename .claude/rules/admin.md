---
paths:
  - "apps/admin/**"
---

# Admin rules

**R10.** Admin is a separate app, domain, Cognito user pool and CloudFront distribution, with mandatory TOTP MFA and a WAF IP allowlist. Every admin action stores actor, reason, IP and target.

- Specification: docs/spec/16/16.12-admin-screens-wp8.md
