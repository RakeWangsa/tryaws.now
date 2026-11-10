<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "10. Provisioning". Change the plan, then run pnpm spec:split. -->

## 10. Provisioning

### 10.1 Operations

- An operation is a row with a kind, a step and a state: `queued`, `running`, `waiting`, `succeeded`, `failed`, `needs_approval`, `needs_attention`.
- The `provisioner` handles one step per invocation and saves the new step. When the next step can run at once, it sends the operation to the queue again. When it has to wait for AWS (instance pending, database creating, snapshot pending, domain registration in progress) or retry after an error, it sets the state `waiting` with `next_run_at` and sends nothing, because a FIFO queue has no per-message delay. The `scheduler` (every minute) sends `waiting` operations whose `next_run_at` has passed and `queued` operations still unsent 2 minutes after their `next_run_at`, which also recovers a first message lost after the purchase committed.
- Every step is idempotent. Create steps use the deterministic AWS name, so a retry that finds the resource already present with the right tags continues instead of failing.
- After 5 failed attempts the operation becomes `needs_attention` and appears in the admin queue; no refund is posted yet. An admin then retries it (`retryOperation`, back to `queued`) or rejects it (`rejectOperation`). A create becomes `failed` only when it is rejected there or when its error can never succeed on a retry. `failed` is final and `retryOperation` is refused for it. The move to `failed` and the reversing ledger transaction are one database transaction, keyed by the order id, so the reversal is posted once. The same step releases the capacity, sets the subscription to `ended`, queues the removal of anything the create already made in AWS and notifies the customer. If that removal fails, a `discrepancies` row is opened; the refund stands.
- Tags on every AWS resource that supports tags: `tc:env`, `tc:customer`, `tc:resource`, `tc:order`. Instances also get `tc:os` (`linux` or `windows`) at create and at restore; the `TcAccessDetails` policy reads it (Section 6.3). Static IPs and automatic snapshots take no tags; for them the retry rule and the reconciler use the deterministic name or the parent instance, matched against `resources`.

### 10.2 Capacity and limits

- `pool_capacity` rows per pool account, Region and quota code: `instance_vcpu`, `static_ip`, `database`, `load_balancer`, `container_service`, `certificate_active`, `certificate_365d` (certificates created in the last 365 days: 20 per Region, fixed), `disk_gb` (per Region), `bucket`, `distribution` (per account). Certificates for distributions are always created in `us-east-1`, so that Region has its own rows for both certificate codes.
- Reservation happens inside the purchase transaction with `SELECT ... FOR UPDATE` on the affected rows. Sell up to the limit minus a configurable reserve per quota (0 at launch while limits are small; raise it after quotas grow). Release on delete and on failed create. The hourly inventory run corrects `used` from live data, but never below the live count plus the reservations of create operations not yet `succeeded`; `certificate_365d` has no live count and is kept from the platform's own records.
- If the home account is full the order is refused with a waitlist option. It is never placed in another account silently.
- Default limits for risk tier `new` (admin-editable): at most 2 instances, bundle price at most 24 USD, no Windows, no containers, at most 1 static IP each. Tier `trusted`: at most 20 instances until raised by admin.
- Outbound port 25 stays closed (AWS default). Mail sending is not offered at launch.

### 10.3 Product adapters

One adapter per family in `packages/aws/adapters`, all implementing the interface below. `parseConfig` and `capacityNeeds` are pure functions in `packages/core/products` (schemas from `packages/core/validation`), so `createOrderDraft` and `placeOrder` use them without importing `packages/aws`; the adapter imports them from there:

```ts
interface ProductAdapter<C> {
  family: ProductFamily;
  parseConfig(input: unknown): C;                      // zod
  capacityNeeds(config: C): CapacityNeed[];
  aws: {
    create(ctx: OpCtx<C>): Promise<StepResult>;        // multi-step, idempotent
    suspend(ctx: OpCtx<C>): Promise<StepResult>;
    resume(ctx: OpCtx<C>): Promise<StepResult>;
    finalSnapshot(ctx: OpCtx<C>): Promise<StepResult>; // no-op where not supported
    destroy(ctx: OpCtx<C>): Promise<StepResult>;
    purgeSnapshots(ctx: OpCtx<C>): Promise<StepResult>;
    describe(ctx: OpCtx<C>): Promise<LiveState>;
    action(kind: OperationKind, ctx: OpCtx<C>): Promise<StepResult>; // reboot, stop, start, ports, static IP, backups, disks, targets, deploy, records
  };
}
```

| Family (gate) | Create | Suspend at grace | Final snapshot and destroy | Notes |
| --- | --- | --- | --- | --- |
| Linux instance (core) | `ImportKeyPair` if missing, `CreateInstances` with bootstrap user data, wait for running, `AllocateStaticIp`, `AttachStaticIp`, `PutInstancePublicPorts` | Save the port rules, then close all public ports (VERIFY that `PutInstancePublicPorts` with an empty list closes everything). Config switch allows `StopInstance` instead | `CreateInstanceSnapshot`, wait, `DeleteInstance`, `ReleaseStaticIp` | Restore with `CreateInstancesFromSnapshot`. The public IP changes after a restore; say so in the UI |
| Firewall, static IP (core) | `PutInstancePublicPorts`, `OpenInstancePublicPorts`, `CloseInstancePublicPorts`, `AttachStaticIp`, `DetachStaticIp` | with the instance | with the instance | Validate protocols, port ranges and CIDRs with zod |
| Backups (core) | `CreateInstanceSnapshot`, `EnableAddOn` (AutoSnapshot), `DeleteInstanceSnapshot` | keep | manual backups and the final snapshot: purge 14 days after the instance is deleted. AWS deletes automatic backups together with the instance, so after a destroy only manual backups and the final snapshot remain, and the Destroy tab says so | Snapshot storage is metered daily per GB |
| Block storage (core) | `CreateDisk` in the instance's AZ, `AttachDisk` | with the instance | `CreateDiskSnapshot`, `DetachDisk`, `DeleteDisk` | VERIFY attach and detach rules for running instances |
| Windows instance (A) | As Linux, with the pool's default key pair, and without automatic backups: Lightsail does not support the AutoSnapshot add-on on Windows instances, so the create option and the Backups switch are hidden and backups are manual | as Linux | as Linux | Password is fetched on demand by `access-details`, shown once, never stored. UI tells the customer to change it at first login |
| Managed database (A) | `CreateRelationalDatabase` with `publiclyAccessible=false`, wait for available | `StopRelationalDatabase` (AWS restarts it after 7 days, grace is 48 hours) | `DeleteRelationalDatabase` with a final snapshot | Password comes from `GetRelationalDatabaseMasterUserPassword` on demand (VERIFY that Lightsail generates it when omitted). Public mode is a customer toggle with a warning |
| Load balancer (A) | `CreateLoadBalancer`, `AttachInstancesToLoadBalancer`; optional `CreateLoadBalancerTlsCertificate` and `AttachLoadBalancerTlsCertificate` | `DetachInstancesFromLoadBalancer` (remember the list) | `DeleteLoadBalancer` | Targets must be the customer's instances in the same account and Region. HTTPS uses the scarce certificate quota |
| Object storage (A) | `CreateBucket`. Access keys are created on demand by `access-details` (`CreateBucketAccessKey`), because AWS returns the secret only in that response; the secret is returned once (U9) and never stored | Make the bucket private and delete its access keys | `DeleteBucket` with force after 14 days | 20 buckets per pool account; 2 keys per bucket |
| Container service (B) | `CreateContainerService`, `CreateContainerServiceDeployment` | `UpdateContainerService` with `isDisabled=true` (AWS still bills it) | `DeleteContainerService` | Public registry images only at launch. Do not hand out registry logins (`CreateContainerServiceRegistryLogin`), they are account-wide |
| CDN (B) | `CreateDistribution` in `us-east-1` | `UpdateDistribution` with `isEnabled=false` | `DeleteDistribution` | Origin is the customer's own instance, load balancer or bucket. Custom domains need a certificate |
| DNS (B) | Route 53 `CreateHostedZone` in `tc-dns` | none | Delete record sets, `DeleteHostedZone` | Section 12 |
| Domain (B) | Route 53 Domains `RegisterDomain` in `tc-dns` | none | none (expires) | Section 12. `RegisterDomain` also creates a hosted zone: adopt it, never create a second one |

### 10.4 Tenant isolation inside a pool account

Lightsail firewall rules filter only traffic that arrives through the public IP. Instances in the same account and Region can reach each other on private IPs. Databases without public mode are reachable by every Lightsail resource in the same account and Region. Container services have a private domain reachable the same way. The platform therefore adds its own isolation:

1. Bootstrap firewall on every instance through user data, from a fixed template. It installs a systemd unit that applies the rules on every boot and does not depend on `ufw`:
   - read the VPC CIDR from instance metadata (`network/interfaces/macs/<mac>/vpc-ipv4-cidr-block`) with an IMDSv2 session token, because Amazon Linux 2023 and Ubuntu 24 blueprints have IMDSv2 by default and a request without a token can be refused; expected value `172.26.0.0/16` (VERIFY). If the read fails, the unit uses the expected value and still applies the rules, so it fails closed;
   - allow established and related traffic;
   - allow UDP source port 67 to destination port 68 (DHCP);
   - allow TCP 80 from the VPC CIDR (Lightsail load balancer traffic and health checks; load balancers are created with `instancePort` 80, so 443 stays closed). Port 80 is therefore reachable from other servers in the same pool account and Region, and private traffic between a customer's own servers is blocked; the Networking tab says both;
   - drop everything else whose source is inside the VPC CIDR, in a hook that runs before NAT and forwarding (for example an nftables `inet` table at prerouting), so ports published by Docker are covered too.
   Windows gets the equivalent Windows Firewall block rules in a PowerShell launch script (block rules win over allow rules there, so block the port ranges around 80 and UDP 68 rather than everything). VERIFY both scripts on every blueprint that is offered; a blueprint is listed in the catalog only after its bootstrap passes the isolation test.
2. Per-customer SSH key pairs. The private key is generated in the browser or supplied by the customer; only the public key reaches the platform. Start with RSA keys; allow ED25519 only if `ImportKeyPair` accepts it (VERIFY).
3. The pool's default key pair is used only for Windows. `DownloadDefaultKeyPair` is denied to every platform role.
4. Database passwords are generated, at least 24 characters, and shown on demand. The panel recommends TLS connections.
5. The UI never describes a container service without a public endpoint as "private".
6. Customers who need hard isolation get a dedicated pool account (a config row), sold as a separate option later.
7. Isolation test in `tests/isolation` (runs in `tc-pool-dev`): two instances owned by different test customers; B cannot open TCP 22, 443, 3306, a high TCP port or a UDP port on A's private IP, and the test records that B can open TCP 80; B cannot open a port that Docker publishes on A; a load balancer health check to A passes; DHCP renewal on A works after a reboot. Instances are dual-stack by default and every IPv6 address is public, so the test also has an IPv6 case: B cannot open a port on A's IPv6 address that A's IPv6 firewall does not allow, and a rule sent with IPv4 sources only leaves that port closed for IPv6 (VERIFY both). Until both hold, instances are created with `ipAddressType` `ipv4`.

