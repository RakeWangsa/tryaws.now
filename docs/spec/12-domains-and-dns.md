<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 1050-1063. Change the plan, then run pnpm spec:split. -->

## 12. Domains and DNS

All calls run in `tc-dns`. Route 53 Domains uses the `us-east-1` endpoint.

- TLD catalog: `ListPrices` daily into `tlds`. Show every TLD. TLDs that require extra parameters or eligibility proof are listed too, but their orders go to an admin review step before `RegisterDomain`.
- Search: `CheckDomainAvailability`. Price: registration price through the pricing engine, per year.
- Register: collect registrant contact details from the customer (the customer is the registrant), privacy protection on where the TLD supports it, `AutoRenew=false`. Poll `GetOperationDetail`. The registrant must confirm the verification email or the domain is suspended by the registry; show that status and offer `ResendContactReachabilityEmail`.
- No refunds on registrations. Require a second confirmation that repeats the exact domain name.
- Renewal is prepaid: reminders 60, 30 and 7 days before expiry, then `RenewDomain` when the wallet is charged.
- Quota: 20 domains per account by default. Request an increase for `tc-dns` on Day 0.
- DNS zones: `CreateHostedZone` with the operation id as caller reference. Zone price is a 30-day product. Record editor for A, AAAA, CNAME, MX, TXT, SRV and CAA through `ChangeResourceRecordSets`; the apex NS and SOA records are read-only.
- A zone is allowed only for a domain the customer registered here or declares to control. Zones that are not delegated to their Route 53 name servers within 14 days are removed after two notices.
- Transfer out is handled by support at launch.

