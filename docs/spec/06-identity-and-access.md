<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 805-833. Change the plan, then run pnpm spec:split. -->

## 6. Identity and access

### 6.1 Customers

- Cognito customer pool: email and password sign-up, email verification, password policy of at least 12 characters, optional TOTP MFA, self-service password reset. Destructive actions (destroy a resource, delete a snapshot, change email or phone) require a fresh sign-in within the last 10 minutes.
- Tokens are kept only in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Nothing in `localStorage`. The server verifies the JWT signature, issuer, audience and expiry on every request and maps the Cognito `sub` to `customers.id`.
- Phone verification is an in-app OTP by SMS: 6 digits, stored hashed, 5 minute expiry, 5 attempts, 3 sends per hour per number and per IP.
- KYC: customer type (individual or business), ID document images uploaded straight to the `kyc` bucket by presigned POST, document number stored encrypted with a KMS data key. Status: `none`, `pending`, `verified`, `rejected`. No resource can be created before `verified`.
- Risk tier is separate from KYC status. Everyone passes KYC; the tier is `new` or `trusted` and drives limits (Section 10.2) and the home pool. A customer becomes `trusted` by admin decision, or automatically after 14 days and one paid renewal with no abuse case.

### 6.2 Admins

- Separate Cognito pool, no self sign-up, TOTP required, short sessions (8 hours), roles `support`, `finance`, `ops`, `superadmin`.
- `ops.ticoncloud.com` is reachable only from the WAF IP allowlist.
- Manual wallet credits and debits: `finance` role only, mandatory reason, and a second admin's approval above a configurable amount.

### 6.3 IAM roles in other accounts (starting point, tighten after VERIFY)

| Role | Account | Trusted principal | Permissions |
| --- | --- | --- | --- |
| `TcProvisioner` | each pool account | `provisioner` function role of the matching control plane (`tc-platform` for customer pools, `tc-platform-stg` for `tc-pool-dev`), with an ExternalId per pool account | Explicit allow-list of the Lightsail actions used by the adapters in Section 10.3. Explicit deny of `lightsail:DownloadDefaultKeyPair`, `lightsail:PeerVpc`, `lightsail:UnpeerVpc`, `lightsail:ExportSnapshot`, `lightsail:CreateCloudFormationStack`, `lightsail:GetInstanceAccessDetails` |
| `TcReader` | each pool account | `reader`, `catalog-sync`, `reconciler` roles | Lightsail `Get*` only, without `GetInstanceAccessDetails`, `GetRelationalDatabaseMasterUserPassword`, `DownloadDefaultKeyPair` |
| `TcAccessDetails` | each pool account | `access-details` role | `lightsail:GetInstanceAccessDetails`, `lightsail:GetRelationalDatabaseMasterUserPassword` only |
| `TcDnsProvisioner` | `tc-dns` | `provisioner` role | The Route 53 and Route 53 Domains actions in Section 12 |
| `TcDnsReader` | `tc-dns` | `reader`, `catalog-sync` roles | `route53domains:CheckDomainAvailability`, `route53domains:GetDomainSuggestions`, `route53domains:ListPrices`, `route53domains:GetDomainDetail`, `route53:GetHostedZone`, `route53:ListResourceRecordSets` only |
| `TcBillingReader` | management | `reconciler` role | `ce:GetCostAndUsage` only |

SCP on the pool OU: deny every action except `lightsail:*` and the minimum read-only support actions, and deny Lightsail outside `ap-southeast-1`, `ap-south-1` and `us-east-1` (distributions and other global Lightsail resources are managed through `us-east-1`). SCP on `tc-dns`: only Route 53 and Route 53 Domains. VERIFY in `tc-pool-dev` that first-use setup of Lightsail is not blocked, then record the final policy JSON in `infra/`.

