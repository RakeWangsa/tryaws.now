<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "12. Domains and DNS". Change the plan, then run pnpm spec:split. -->

## 12. Domains and DNS

All calls run in `tc-dns`. Route 53 Domains uses the `us-east-1` endpoint.

- TLD catalog: `ListPrices` daily into `tlds`. Show every TLD. TLDs that require extra parameters or eligibility proof are listed too, but their orders go to an admin review step before `RegisterDomain`.
- Search: `CheckDomainAvailability`. Price: registration price through the pricing engine, per year.
- Register: collect registrant contact details from the customer (the customer is the registrant), privacy protection on where the TLD supports it, `AutoRenew=false`. Poll `GetOperationDetail`. The registrant must confirm the verification email or the domain is suspended by the registry; show that status and offer `ResendContactReachabilityEmail`. `setNameServers` calls `UpdateDomainNameservers`.
- `RegisterDomain` itself creates a Route 53 hosted zone with the domain's name in `tc-dns` and points the domain's name servers to it; AWS bills it like any hosted zone, unless it is deleted within 12 hours. After the registration succeeds, find it with `ListHostedZonesByName` and record its id on the `domains` row. If the customer orders a DNS zone for that name, this zone is the one: save it as the `dns_zones` row and never call `CreateHostedZone` for a domain registered here. If the customer bought no DNS zone, keep the zone and count it as TiCON's cost until the owner decides what to do with it (Section 17). VERIFY in `tc-dns` with the first real registration.
- No refunds on registrations. Require a second confirmation that repeats the exact domain name.
- TiCON registers names for its customers, so it is a reseller under section 3.12 of the Route 53 Domain Name Registration Agreement. The domain flag stays off until the customer's domain registration agreement in `content/legal/` carries the provisions ICANN requires, names the sponsoring registrar or links a lookup, and links ICANN's Registrant Educational Information and Registrants' Benefits and Responsibilities pages, and until the order flow saves the customer's consent to the processing of registration data in `legal_acceptances`. No ICANN logo is shown.
- Renewal is prepaid: reminders 60, 30 and 7 days before expiry, then `RenewDomain` when the wallet is charged.
- Quota: 20 domains per account by default. Request an increase for `tc-dns` on Day 0.
- DNS zones: `CreateHostedZone` with the operation id as caller reference, except for a domain registered here, whose automatic hosted zone is adopted (see Register). Zone price is a 30-day product. Record editor for A, AAAA, CNAME, MX, TXT, SRV and CAA through `ChangeResourceRecordSets`; the apex NS and SOA records are read-only.
- A zone is allowed only for a domain the customer registered here or declares to control. Zones that are not delegated to their Route 53 name servers within 14 days are removed after two notices.
- Transfer out is handled by support at launch.

