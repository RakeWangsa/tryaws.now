# Lightsail parity gap analysis (WPU-A1)

Analysis only. No application code changed. Date of the repo state: base `worktree-sdd-mega-plan` at 529d9fb (WP5-T6c).
Owner ruling behind this file: the customer panel should feel like the native Amazon Lightsail console, and for now the platform runs on ONE AWS pool account.

Status words: done = built and unit-tested in the repo (no real AWS proof anywhere yet, see "Global caveats"); partial = some of the behaviour exists; missing = nothing for the customer.
Task ids below are proposals (`WPU-G*` for the panel, `WPU-P*` for the pool); none is in `docs/spec/E-backlog-and-prompts.md`. Sizes: S under half a day, M about a day, L several days or an owner decision first.
Priority: 1 = a new customer on a first launch meets it or is blocked by it; 2 = soon after launch; 3 = later. Ordered by what a customer meets first.

## Sources and VERIFY items

Native behaviour was checked against current AWS documentation (search of docs.aws.amazon.com, 2026-11-12). Confirmed:

- Create instance flow: location (Region and Availability Zone, changeable), platform (Linux/Unix or Windows), Apps + OS or OS only, instance plan, networking type (dual-stack or IPv6-only; some blueprints do not support IPv6-only), optional automatic snapshots with a time of day, name (2 to 255 characters, unique per Region), optional tags, optional launch script and SSH key pair. Source: "Create Linux/Unix instances with apps on Lightsail".
- Browser-based SSH and RDP clients in the console; they use a separate key pair, so they work even if the customer's own key is lost. Source: "Manage SSH key pairs and connect to your Lightsail instances".
- Each instance has two independent firewalls, IPv4 and IPv6; rules filter traffic that arrives through the public IP only. Source: "Control instance traffic with firewalls in Lightsail".
- Static IP: five per Region by default, one per instance; a deleted static IP cannot be re-added. Buckets: 20 per account. Disks per instance: 15. Source: repost knowledge centre, Lightsail FAQs, "Amazon Lightsail endpoints and quotas". New accounts may start below the documented quotas.

VERIFY items (not confirmed, to record in JOURNEY.md when a task touches them):
- V1. Whether `GetInstanceAccessDetails` temporary credentials can drive a platform-hosted browser terminal. The console client is AWS-internal; the public API returns a short-lived key and certificate for a third-party client. The spec (10.4, 6.3) allows `TcAccessDetails` for Windows passwords and bucket keys only. Browser SSH is therefore an owner decision, not a small task.
- V2. Default login user name per blueprint (`ubuntu`, `ec2-user`, `admin`, `bitnami`, `ec2-user` for Amazon Linux 2023). Read it from `GetBlueprints` (`GetInstanceAccessDetails` returns `username`).
- V3. The exact current list of blueprints and which support IPv6-only (`GetBlueprints`, run in `tc-pool-dev`).
- V4. The exact Lightsail quotas of the real pool account per Region (new accounts start lower; see "Pool account with exactly one account").
- V5. Whether the `PutInstancePublicPorts` payload of the adapter carries `ipv6Cidrs` (the isolation test of 10.4 decides when dual-stack is allowed).

## Global caveats (affect every row)

- No adapter has run against real AWS. All adapter tests use fakes (`packages/aws/test/fake-aws.ts`). "done" means code and unit tests only.
- Create of a Linux server cannot finish in production as wired: `functions/provisioner/linux.ts` answers `bootstrapMarker: async () => "absent"`, so the create stops before the static IP and never hands over the instance (R16, WP4-T5 open point 2). Nothing else in the onboarding matters until this is wired or the probe is replaced.
- The web tier has no SQS client (R1), so operation rows wait for the scheduler sweep (minutes) before the first step runs. A customer clicks "Create" and sees "creating" for longer than in the native console (seconds).
- Metrics, database password reveal, Windows password reveal, bucket secret key all depend on bindings from the web tier to `reader` and `access-details` that are not wired (`apps/web/server/reader-port.ts` returns `null`).
- `docs/spec` was not edited. Several rows below need a contract change (Section F of the plan) and so are their own pull requests, not part of a task.

## Pool account with exactly one account

Code read: `packages/core/capacity/{allocate,decide,reserve,release,inventory}.ts`, `packages/db/repositories/capacity.ts`, `packages/db/capacity-keys.ts`, `functions/provisioner/{claim,step}.ts`, `packages/aws/{roles,access}.ts`, `docs/runbooks/pool-account-onboarding.md`.

How selection works: `decide()` reads the customer's `riskTier`. If the customer has no row in `customer_homes` for the order Region, it takes the capacity cells of every ACTIVE pool account whose `tier` equals the customer's tier and runs `allocate()` (first by pool account id, all needs or nothing). If a home exists for the Region it uses that account only. The first successful order writes the home (`customer_homes` is per customer and Region). With one account the "overflow" is trivial: there is one candidate. The code does not need a second account to work, but several things must be true in the data.

Failure cases with one account:

| # | Case | What happens | Mitigation |
| --- | --- | --- | --- |
| P1 | The one account has tier `trusted` and the customer is tier `new` (or the reverse). The selector is `tiers: [profile.riskTier]` with an exact match; a `new` customer never sees a `trusted` account. | `allocate` has no candidate, reason `not_configured`, `capacity_full` answer with no waitlist offer. Every new signup (default tier `new`) is refused. | Register the single account with tier `new`. Then a customer promoted to `trusted` who has no home yet in a Region is refused (existing homes keep working). Decide: add a rule "a `trusted` customer may use `new` accounts" (contract-adjacent: changes `decide` step 5, no Section F change) or run one account as `new` and promote nobody before a second account exists. Task WPU-P1. |
| P2 | No `pool_capacity` row for the order Region and quota code. | `judge` = `missing` for every candidate, `not_configured`, no waitlist. | Seed all quota codes for all three launch Regions (`ap-southeast-1`, `ap-south-1`, `us-east-1`) with real limits: instance_vcpu, static_ip, database, load_balancer, container_service, certificate_active, certificate_365d, disk_gb per Region; bucket and distribution once as Region `global`; certificate rows for `us-east-1` also serve distributions. Task WPU-P2 (seed script and `verify` check). |
| P3 | Real AWS quotas lower than the seeded `quota_limit` (new accounts start lower, V4). | Capacity says "fits", AWS refuses with a quota error. The adapter maps it to `poolFull` (`packages/aws/errors.ts`). The order fails and is refunded; the customer sees a failure, not the waitlist. | Record real quotas first (runbook step 6), set limits to the real values, raise the reserve. Add a "pool full from AWS" path that marks the cell full for the account. Task WPU-P3 (S). |
| P4 | Account `status = disabled` (admin disables it, or the account is suspended by AWS). | Not a candidate and home accounts that are not active leave no candidate. All new orders in all Regions are refused with `not_configured`; the waitlist is NOT offered (`waitlistOffer` only for `full`). Existing resources are not touched. | Treat as incident ([incident.md](incident.md)). Customer text for `not_configured` should say "temporarily not available", not "full". Task WPU-P4 (S, wording). |
| P5 | Account full (limit minus reserve used up). | `full`, waitlist offered and `notifyWaitlist` can notify, but with one account nothing can free capacity except deletes or a quota increase. | Quota request at 70 percent (`capacityWarning`), runbook [capacity-full-and-quota.md](capacity-full-and-quota.md). Already implemented. |
| P6 | A request larger than the sellable part (`too_large`), e.g. a 16 TB disk or more vCPU than the limit minus reserve. | `too_large`, no waitlist. | Limit sizes in the configurator to what is sellable. |
| P7 | One account, many tenants: Lightsail private networking lets resources in the same account and Region reach each other; databases without public mode are reachable by every Lightsail resource there (10.4). | Isolation depends only on the bootstrap firewall on instances; databases and container services have no such layer. | Keep database public mode off and say so; run the isolation test (WP4-T6) before any customer. Hard isolation (a dedicated account) is a later option by design. |
| P8 | One abuse report or an AWS suspension hits every customer at once. | Whole platform affected. | Security alternate contact (WP0-T5), abuse runbook [abuse-notice-and-suspension.md](abuse-notice-and-suspension.md); a second account is the real fix (runbook [pool-account-onboarding.md](pool-account-onboarding.md)). |
| P9 | `disk` anchor row exists only for `ap-southeast-1` and `ap-south-1` (migration 0008). | A disk order in `us-east-1` has no anchor row, so it is refused. Servers in `us-east-1` can have no extra disk. | Add the `us-east-1` row in a new forward migration, or drop `us-east-1` from the server Regions. Task WPU-P5 (S). |
| P10 | A restore or an extra disk must live in the pool account of the source (WP5-T6b point c). | With one account this is always true. It becomes a failure only after the second account. | Note for the day a second account is added: prefer the source's account in `allocate`. |
| P11 | `readLaunchInputs`/`claim` resolve the account from `resources.pool_account_id` and `pool_accounts.aws_account_id` plus `external_id`; roles are `TcProvisioner`, `TcReader`, `TcAccessDetails` assumed with the ExternalId. | A wrong ExternalId or a missing role gives `forbidden` on every operation; all operations go to `needs_attention`. | The smoke test of the runbook (staging, `tc-pool-dev`) before production; one account means no fallback. |
| P12 | `inventory` hourly run corrects `used` from live data but never below live count plus pending reservations. | If the one account also holds non-platform resources (a developer's test instance), `used` rises and sellable capacity falls. | Keep the pool account dedicated; the reconciler shows unexplained resources. |

Nothing in the code assumes more than one account, so the single-account launch needs data and one tier decision (P1), not new selection code.

## Gap table

Order: onboarding first (sign up, first server, connect, snapshot, firewall, static IP, disk, backups), then the other families.

### A. Onboarding

| Feature | Native Lightsail behaviour | Status in repo | Suggested task (id, size, files) | Pri |
| --- | --- | --- | --- | --- |
| Sign-up, email verify, sign-in, password reset | AWS account sign-up (not comparable); the panel needs its own | done: `(auth)/signup,verify,login,forgot-password,reset-password`, WP2-T2 | none | 1 |
| Phone OTP | n/a | done in code (`server/phone-step.ts`, WP2-T3); SMS provider adapter not proven | WPU-G0 SMS live check, S, `packages/notify` | 1 |
| KYC before first resource | n/a (platform rule) | done: `/kyc`, admin review | none | 1 |
| Wallet top-up, first order with short balance | n/a | done: `/wallet/topup`, `/orders/review` (shortfall button) | none | 1 |
| Dashboard first-use checklist | Console home shows "Create instance" at once | done: checklist phone, KYC, top-up, server (`dashboard/DashboardContent.tsx`) | none | 1 |
| Time to first running server | Seconds to a few minutes | partial: create is queued by sweep, not SQS (web has no SQS client); create stops at `verify_bootstrap` because the marker probe answers `absent` | WPU-G1 wire the bootstrap probe, M, `functions/provisioner/linux.ts`, `packages/aws/adapters/linux-instance.ts`, `tests/isolation`; WPU-G2 queue port for web, M, `infra/`, `apps/web/server/orders-runtime.ts` (new dependency with recorded reason) | 1 |

### B. Create instance wizard (`/servers/new`)

Spec rows: 16.10 `/servers/new` lists location, image (tabs OS and apps, `ImageTile`), plan, SSH key, options (automatic backups, label). The built form has location, plan, SSH key, name only.

| Feature | Native Lightsail behaviour | Status in repo | Suggested task | Pri |
| --- | --- | --- | --- | --- |
| Location: Region | Region choice | done for 3 Regions (`LIGHTSAIL_REGIONS`), `ConfigForm` region radios | none | 1 |
| Location: Availability Zone | Zone shown, changeable | missing: adapter hardcodes `${region}a` (`linux-instance.ts` create); not in `parseInstanceConfig`; disks use the same zone | WPU-G3 zone choice in config, M, `packages/core/products` (config field = contract check), adapter, `ConfigForm`; or show the zone read-only (S) | 2 |
| Platform choice (Linux/Unix, Windows) | Tabs | partial: Windows adapter and screens exist (WP6-T1), but the configurator has no platform switch and Windows is behind its own flag; `new` tier refuses Windows | WPU-G4 platform tabs in the configurator, S, `ConfigForm.tsx` | 2 |
| Blueprint: Apps + OS vs OS only | Many app blueprints (WordPress, LAMP, Node, etc.) and OS images | missing: `DEFAULT_BLUEPRINT_ID = "ubuntu_24_04"` for every Linux server; `catalog-sync` reads `GetBundles` only (`packages/aws/catalog.ts`), not `GetBlueprints`; spec 10.4 lists a blueprint only after its bootstrap passes the isolation test; admin "blueprint allow-list" (spec 13) not built | WPU-G5 blueprint catalog: `GetBlueprints` in catalog-sync, allow-list table, `ImageTile` step, blueprint in order config (contract change, own PR), per-blueprint bootstrap test, L, `packages/aws/catalog.ts`, `packages/core/products`, `packages/db` migration, admin catalog screen, `ConfigForm`. Launch minimum: 2 or 3 OS-only blueprints (Ubuntu 24.04, Amazon Linux 2023, Debian) | 1 |
| SSH key pair | Default key, create new, upload; downloads private key once | partial: `/settings/ssh-keys` paste or generate in the browser (Web Crypto), per-customer keys by spec; no "use Lightsail default key"; "none" allowed in form (`keyNone`) | WPU-G6 require a key for Linux (or auto-generate at create), S, `ConfigForm`, `parseInstanceConfig` | 1 |
| Network type (dual-stack / IPv6-only) | Choice; IPv6-only cheaper | missing by design: adapter `ipAddressType: "ipv4"`; IPv6-only bundles inactive (spec 8); dual-stack waits for the IPv6 isolation test (10.4) | WPU-G7 allow dual-stack after isolation test, M, `tests/isolation`, adapter, firewall IPv6 rules | 3 |
| Automatic snapshots at create (with time) | Toggle plus time of day | missing at create: backup adapter has `EnableAddOn` and the Backups tab has the switch with an hour (`setAutoBackupCore`), but the configurator has no option (WP4-T7 open point 3, contract) | WPU-G8 option in configurator, S, `ConfigForm`, `parseInstanceConfig` (contract), enable-add-on step after create | 1 |
| Plan (bundle) | Plans table with vCPU, RAM, SSD, transfer, price | done: plan picker, price from the server at page load; no live re-quote on change (WP4-T7 open point 4) | WPU-G9 read-only quote action, S, `apps/web/server` | 2 |
| Name | 2 to 255 chars, unique per Region | done as label; AWS name is generated (R11), correct by design | none | 1 |
| Tags (key/value) | Add tags in wizard and later | missing; by rule R11 customer text never becomes a tag key. Platform tags `tc:*` exist | WPU-G10 customer labels stored in the database only (not as AWS tags), S, `packages/db`, tab Overview | 3 |
| Launch script (user data) | Optional | missing by design: user data is the platform bootstrap firewall (10.4) | none (state in the UI help); optional later: append a validated script after the bootstrap | 3 |
| Review and pay | Create instance button, billed per hour | done: draft token, `/orders/review`, wallet, 30-day term (platform model differs: prepaid) | none | 1 |
| Order status | Pending then Running | done: `/orders/[id]`, refresh; refund line on failure | none | 1 |

### C. Instance page (`/servers/[id]`)

Built tabs: Overview, Access, Networking, Backups, Storage, Metrics, Billing, Destroy. Native tabs: Connect, Metrics, Networking, Storage, Snapshots, Tags, History, Delete.

| Feature | Native Lightsail behaviour | Status in repo | Suggested task | Pri |
| --- | --- | --- | --- | --- |
| Power: reboot, stop, start | Buttons in the header and menu | partial: operation kinds `reboot`, `stop`, `start`, `rename` exist and are customer-requestable (`packages/db/operations/kinds.ts`) and the adapter handles them; spec lists `rebootServer, stopServer, startServer, renameServer` on Overview. No Server Action and no button (`ServerDetailContent` Overview has stat tiles only) | WPU-G11 power buttons and rename, M, `apps/web/server/server-actions.ts` (new core in `extras-actions.ts` style), `ServerDetailContent.tsx`, `endpoint-sweep.cases.ts`, cross-tenant tests | 1 |
| Connect: browser SSH / RDP | One-click browser terminal (separate key) | missing; V1: needs owner decision. Today: copy a command | WPU-G12 decision memo, then L (WebSocket proxy or documented "not offered"), `functions/access-details`, infra | 2 |
| Connect: SSH command | Shows user and host | partial: shows `ssh <user>@<ip>` with a literal placeholder (`detail.access.ssh`); no user name; no default key download; key name shown | WPU-G13 login user per blueprint (V2), S, `ServerDetailContent.tsx`, catalog row `specs.loginUser` | 1 |
| Connect: Windows RDP + password | Browser RDP, show default password | partial: RDP address, password on demand (`WindowsAccess`, shown once) but the transport to `access-details` is `null` so every reveal is refused (WP6-T1b a) | WPU-G14 wire `access-details` invoke, M, `infra/`, `apps/web/server/action-deps.ts` | 2 |
| Overview facts | Name, Region/zone, plan, IPs, state, created, blueprint | partial: specs, Region, public IP, created, state; no zone, no blueprint, no private IP, no IPv6, no period end on this tab | WPU-G15 richer Overview, S, `ServerDetailContent.tsx`, `servers-view.ts` | 2 |
| Metrics | CPU, network in/out, status checks; 1h/1d/1w/custom | partial: tab and port exist; `getReaderPort()` returns `null`, so "not available". `reader` function exists (WP5-T3) | WPU-G16 invoke binding of `reader` and chart rendering, M, `infra/`, `apps/web/server/reader-port.ts`, `ExtrasTabs.tsx` | 1 |
| Networking: IPv4 firewall rules | Table with application presets (SSH, HTTP, HTTPS, RDP, ICMP, custom), protocol, port range, restrict to IP | missing: Networking tab says "rules soon" (`rulesSoon`). `set_ports` kind and `parsePortRules` exist; spec action `saveFirewallRules` not built | WPU-G17 firewall editor with presets and "restrict to IP", M, `ServerDetailContent.tsx`, new `firewall-actions.ts`, cross-tenant test; keep the platform bootstrap rules out of the editable set | 1 |
| Networking: IPv6 firewall | Separate table | missing (instances are IPv4 only, see wizard) | with WPU-G7 | 3 |
| Networking: static IP attach/detach/release | Create and attach on the Networking tab; five per Region | partial: create already allocates and attaches a static IP (spec); tab shows the IP as a copy field only; kinds `attach_static_ip`, `detach_static_ip` exist, no UI; `attachStaticIp`/`detachStaticIp` of 16.10 not built; no standalone "Static IPs" list | WPU-G18 attach/detach/replace static IP actions + list, M, `server-actions.ts`, `ServerDetailContent.tsx`; capacity `static_ip` cell | 1 |
| Networking: private IP, DNS records for the instance | Shown | missing | in WPU-G15 | 3 |
| Storage: attach / detach / create disk | Disks tab with add, attach, detach, delete, resize | partial: Storage tab lists disks, attach/detach/destroy forms (WP5-T6), add disk order (WP5-T6c, Linux only). Missing: resize, disk snapshot, `us-east-1` anchor (P9), Windows disks, mount instructions | WPU-G19 mount help text and disk snapshot, S/M, `ExtrasTabs.tsx`; resize L (AWS cannot resize a disk in place; create from snapshot) | 1 |
| Snapshots tab: create, delete, restore | Create snapshot, list, "Create new instance" from snapshot | done in code: Backups tab create/delete, auto-backup switch with hour, `restoreToNewServer` order (WP5-T6b); final backup protected. No standalone `/snapshots` list across servers; no snapshot of a deleted server except the final backup; 10 manual per server cap | WPU-G20 account-wide Snapshots page (list, restore, delete), M, `apps/web/app/[locale]/(panel)/snapshots`, nav entry | 2 |
| Automatic snapshots (add-on, daily time, 7 kept) | Toggle, time | done: `setAutoBackupCore` with hour; Windows hidden by spec | none | 1 |
| History tab | Activity of the resource | partial: `operations.listRecent` exists and the dashboard shows the last five; no per-server history tab | WPU-G21 History tab from `operations` rows, S, `ExtrasTabs.tsx` | 2 |
| Tags tab | Edit tags | missing (see wizard) | WPU-G10 | 3 |
| Delete instance | Delete with confirm | done: Destroy tab (typed name, fresh sign-in, final snapshot, admin approval until 2026-12-01, R13) | none | 1 |
| Rename | Rename not possible in native (name is permanent) | built as display label only | none | 3 |
| Billing / renewal | Per-hour billing, usage in Billing | done: Billing tab, auto renew, renew now (7-day window) | none | 1 |
| Data transfer used vs allowance | Metrics/Networking graph | partial: needs the reader (see Metrics); metering exists (WP7-T5) | with WPU-G16 | 2 |

### D. Other products

| Feature | Native Lightsail behaviour | Status in repo | Suggested task | Pri |
| --- | --- | --- | --- | --- |
| Static IPs page | List, create, attach, detach, delete | missing as a page (see instance Networking) | WPU-G18 | 2 |
| Load balancer: create, attach instances | Create with name, protocol/port, health check path, attach targets | partial: create and screens (WP6-T3); `setTargets` has a core but no operation kind (adapter `action` refuses) so "not available yet"; targets at create work | WPU-G22 `set_targets` kind (adapter, db enum is a migration), M, `packages/aws/adapters/load-balancer.ts`, `packages/db/operations/kinds.ts` | 2 |
| Load balancer: TLS certificate | Create certificate, domains, validation records, attach | missing in adapter (spec lists `CreateLoadBalancerTlsCertificate`; page says not built) | WPU-G23 certificate request and validation display, L, adapter, UI, `certificate_*` quota | 2 |
| Load balancer: health | Per-target health, health check path | missing (needs reader; health path not in config) | WPU-G24 health via reader, M | 3 |
| Databases: create | Engine/version blueprint, plan, master password, availability zone, backup window | partial: create from plan, engine fixed by plan, private only; endpoint and port are not written back so the page says "shows after creation" (WP6-T2 d); password reveal transport is `null` (refused) | WPU-G25 write endpoint/port, wire reveal, M, `packages/aws/adapters/database.ts`, `access-details` | 2 |
| Databases: backups | Automatic backups, point-in-time restore, manual snapshots, restore | partial: automatic by AWS, final snapshot at destroy; manual snapshot not offered (parent family rule); no restore UI | WPU-G26 manual DB snapshot and restore to new DB, L | 2 |
| Databases: parameters | Edit engine parameters | missing, no adapter call | WPU-G27 parameters (`GetRelationalDatabaseParameters`, `UpdateRelationalDatabaseParameters`), M | 3 |
| Databases: public mode | Toggle publicly accessible | missing (no kind; adapter creates private; tab shows "off") | WPU-G28 `set_public_mode` kind, warning, M | 3 |
| Buckets: create, access mode | Create, bucket plan, permissions (private, all objects public, per-object), resource access, versioning, access keys, objects browser | partial: create, access mode action, key create (secret once) and delete; current mode not readable (B2), key list not readable, destroy gated by guard (B1); no object browser by design (customers use S3 API with keys); no versioning toggle, no bucket-to-instance access | WPU-G29 mode read-back, keys list via reader, versioning (`UpdateBucket`), M, adapter + `bucket-view.ts` | 2 |
| Container services | Create (power, scale), deployments, public endpoint, custom domains | done for create/deploy (WP7-T1 screens): public images only, no registry login by rule, public URL not stored (B5), no metrics, no custom domain | WPU-G30 store `url`, S, adapter `configMerge` | 3 |
| CDN distributions | Create, origin, cache behaviors, custom domain, certificate, enable/disable, flush cache | partial: create/enable/disable/destroy (WP7-T2). Missing: cache behaviours, flush, custom domains + certificate | WPU-G31 reset cache + custom domain, M | 3 |
| DNS zones and records | Add domain, record editor (A, AAAA, CNAME, MX, TXT, SRV, NS), assign to instance | partial: adapter `applyRecordChange`/`listZoneRecords` done (WP7-T3); NO customer screens: no `/dns` route and no record editor action in `apps/web` (grep finds none); `dns_zone` flag maps to the Domains nav | WPU-G32 `/dns`, `/dns/[zone]`, record editor, M/L, `apps/web/app/[locale]/(panel)/dns`, actions (R9 order), cross-tenant tests | 2 |
| Domains (register, renew, contacts) | Register via Route 53 Domains in the console | done: search, register, verification state, renewal (WP7-T4); needs real Route 53 proof; `tldPrices` of catalog source is "not configured" until `@aws-sdk/client-route-53-domains` is installed | WPU-G33 install client with reason (R17), S | 2 |
| Snapshots / restore across products | Snapshots page for instances, disks, databases | partial, see instance Snapshots | WPU-G20 | 2 |
| Billing and usage | Billing page, usage per resource | partial: wallet, ledger, billing tab; `/invoices` and `/invoices/[id]` are in the navigation (`packages/ui/shells/nav.ts`) but there is no route in `apps/web/app` (dead link); `invoice-renderer` function exists | WPU-G34 invoices list and PDF link, M, `apps/web/app/[locale]/(panel)/invoices`, `getInvoicePdfUrl` | 1 |
| Notifications | n/a | done: `/notifications`, bell | none | 2 |
| Support requests | n/a | done: `/support/new` | none | 2 |
| Account-level resource overview (Home with all resources, Region switcher) | Home lists all resources | partial: dashboard counts per family; no cross-Region list | in WPU-G15 | 3 |

## Priority 1 list in onboarding order

1. WPU-G1 (M) First server must complete: replace the `absent` bootstrap marker probe so create reaches static IP and hand-over.
2. WPU-P1 (S/M) Single pool account tier: register the account as tier `new` (or let `trusted` use it) so signups are not refused; plus WPU-P2 seed all capacity cells for three Regions.
3. WPU-G2 (M) Queue port for the web tier so create starts in seconds, not at the next scheduler sweep.
4. WPU-G5 (L) Image step: blueprint catalog (`GetBlueprints`), allow-list, 2 or 3 OS images; today every server is Ubuntu 24.04 and the spec's image step is absent.
5. WPU-G6 (S) Require or auto-create an SSH key for Linux (today the form allows "none").
6. WPU-G13 (S) Connect help: real login user per blueprint instead of the literal `ssh <user>@ip`.
7. WPU-G8 (S) Automatic snapshot option in the wizard (backups switch exists only after create).
8. WPU-G17 (M) Firewall rules editor (Networking tab says "soon"); needed to open HTTP/HTTPS.
9. WPU-G18 (M) Static IP attach, detach, replace on the Networking tab and a Static IPs list.
10. WPU-G11 (M) Reboot, stop, start, rename buttons (kinds and adapter exist, no UI).
11. WPU-G16 (M) Metrics: bind `reader` so the tab shows CPU and network.
12. WPU-G34 (M) `/invoices` route (dead navigation link).
13. WPU-G19 (S/M) Disk help and `us-east-1` anchor (WPU-P5).

Priority 2 highlights: browser SSH decision (WPU-G12), Windows password transport (WPU-G14), account-wide snapshots page (WPU-G20), History tab (WPU-G21), DNS record editor screens (WPU-G32), load balancer targets and certificates (WPU-G22, G23), database endpoint/reveal/snapshots (WPU-G25, G26), bucket read-back (WPU-G29), AZ choice (WPU-G3).
Priority 3: tags, IPv6/dual-stack, DB parameters and public mode, CDN cache tools, container URL.

## Not comparable by design

- Per-hour billing, free tier and "Lightsail resources in my own AWS account": TiCON is prepaid in BDT, resources live in TiCON pool accounts; AWS ids, ARNs and raw errors are never shown (rules R11, U6).
- Customer-chosen resource names and tag keys become platform labels, not AWS names (R11).
- Launch script, default key pair download, IPv6-only plans: not offered until the isolation test passes (10.4).
- Direct S3 console for objects: the customer uses their own S3-compatible client with access keys.
