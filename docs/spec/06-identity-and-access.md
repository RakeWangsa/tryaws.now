<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 815-843. Change the plan, then run pnpm spec:split. -->

## 6. Identity and access

### 6.1 Customers

- Cognito customer pool: email and password sign-up, email verification, password policy of at least 12 characters, optional TOTP MFA, self-service password reset. Destructive actions (destroy a resource, delete a snapshot, change email or phone) and sensitive ones (enable or disable TOTP, reveal any password, create a bucket access key, change name servers, switch database public mode) require a fresh sign-in within the last 10 minutes.
- Tokens are kept only in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Nothing in `localStorage`. The server verifies the access token's signature, issuer, `client_id`, `token_use` and expiry on every request (`aud` exists only in the ID token and is checked there), maps the Cognito `sub` to `customers.id`, and refuses a token issued before the customer's `sessions_valid_after` time or for a customer who is not active. Revoked Cognito tokens still pass the local check until they expire, so sign-out everywhere, a password change and a suspension set `sessions_valid_after` (with `AdminUserGlobalSignOut`); the acting browser signs in again. Admin tokens are checked the same way against `admin_users.status`. `proxy.ts` refreshes an expiring access token before rendering, because Server Components cannot set cookies.
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
| `TcProvisioner` | each pool account | the matching control plane account (`tc-platform` for customer pools, `tc-platform-stg` for `tc-pool-dev`) with the condition `aws:PrincipalArn` = its `provisioner` function role, and `sts:ExternalId` per pool account (a plain value in `pool_accounts`). In this row and the rows below, write the trust as the control plane account with an `aws:PrincipalArn` condition, and give the function roles fixed names in `infra/`: a trust that names a role directly stores its internal id, breaks when a deploy recreates the role, and cannot be saved before the role exists | Explicit allow-list of the Lightsail actions used by the adapters in Section 10.3: every command the adapters call, including the Get, start, stop and restore calls that the table there does not name, plus `lightsail:TagResource`, which AWS also checks when a create carries tags. Explicit deny of `lightsail:DownloadDefaultKeyPair`, `lightsail:PeerVpc`, `lightsail:UnpeerVpc`, `lightsail:ExportSnapshot`, `lightsail:CreateCloudFormationStack`, `lightsail:GetInstanceAccessDetails` |
| `TcReader` | each pool account | `reader`, `catalog-sync`, `reconciler` roles | Lightsail `Get*` only, without `GetInstanceAccessDetails`, `GetRelationalDatabaseMasterUserPassword`, `DownloadDefaultKeyPair` |
| `TcAccessDetails` | each pool account | `access-details` role | `lightsail:GetInstanceAccessDetails` only on instances tagged `tc:os` = `windows` (condition `aws:ResourceTag/tc:os`), because for a Linux instance the same call returns a temporary SSH key; `lightsail:GetRelationalDatabaseMasterUserPassword`; `lightsail:CreateBucketAccessKey`. Nothing else |
| `TcDnsProvisioner` | `tc-dns` | `provisioner` role | The Route 53 and Route 53 Domains actions in Section 12 |
| `TcDnsReader` | `tc-dns` | `reader`, `catalog-sync`, `reconciler` roles | `route53domains:CheckDomainAvailability`, `route53domains:GetDomainSuggestions`, `route53domains:ListPrices`, `route53domains:GetDomainDetail`, `route53domains:GetContactReachabilityStatus` (the contact verification state of Section 12, which `GetDomainDetail` does not return), `route53domains:ListDomains`, `route53:ListHostedZones`, `route53:GetHostedZone`, `route53:ListResourceRecordSets` only |
| `TcBillingReader` | each pool account and `tc-dns` | `reconciler` role of the matching control plane | `ce:GetCostAndUsage` only (a member account sees only its own cost) |

SCP on the pool OU: deny every action except `lightsail:*` and the minimum read-only support actions, and deny Lightsail outside `ap-southeast-1`, `ap-south-1` and `us-east-1` (distributions and other global Lightsail resources are managed through `us-east-1`). SCP on `tc-dns`: only Route 53 and Route 53 Domains. Both SCPs also allow `ce:GetCostAndUsage` for `TcBillingReader`. An SCP also binds the root user and every admin role of a member account, so both SCPs exempt one named admin role (condition on `aws:PrincipalArn`) for IAM changes to the `Tc` roles, Service Quotas requests and support cases: static IP, vCPU and domain increases are requested inside the account. Before the SCP is attached, DevOps creates and deletes one bucket in each pool account as that admin, so that Lightsail creates its service-linked role `AWSServiceRoleForLightsail`; `TcProvisioner` has no IAM permission to create it. VERIFY in `tc-pool-dev`, with the SCP attached, that `TcProvisioner` can create an instance and a bucket and that the admin role can list and file a quota increase, then record the final policy JSON in `infra/`.

