export { createAwsAccess, type AwsAccess, type CreateAwsAccessOptions } from "./access";
export { createCatalogSource, type CatalogSource, type TldPrice } from "./catalog";
export type {
  LiveState,
  OpCtx,
  ProductAdapter,
  ProductFamily,
  ResourceView,
} from "./adapters/types";
export {
  METRIC_RANGES,
  createLightsailReadSource,
  MAX_LB_TARGETS,
  type DatabaseMetricName,
  type DatabaseMetricSeries,
  type DatabaseReadRef,
  type LiveReadSource,
  type LoadBalancerReadRef,
  type TargetHealth,
  type TargetHealthRead,
  type TargetHealthReason,
  type TargetHealthState,
  type MetricName,
  type MetricPoint,
  type MetricRange,
  type MetricSeries,
  type ReadTargetRef,
} from "./reader-source";
export { bytesToGbText, createLightsailUsageSource, type UsageSource } from "./usage-source";
export { AwsError, toAwsError, toLogFields, type AwsLogFields, type LocalReason } from "./errors";
export { QUEUE_URL_PATTERN, createSqsClient, createSqsSend, type SqsLike } from "./queue";
export {
  CALLER_ROLES,
  DNS_ROLES,
  ROUTE53_REGION,
  type DnsRole,
  LIGHTSAIL_REGIONS,
  type AccountRef,
  type Caller,
  type LightsailRegion,
  type LightsailRole,
  type RoleName,
  type RoleOf,
} from "./roles";
export {
  BOOTSTRAP_BEACON_PORT,
  BOOTSTRAP_EXPECTED_VPC_CIDR,
  BOOTSTRAP_MARKER_FILE,
  BOOTSTRAP_OK_MARKER,
  bootstrapScript,
  type BootstrapOptions,
} from "./adapters/bootstrap";
export {
  createBeaconMarker,
  parseProbeSources,
  type BeaconMarkerOptions,
} from "./adapters/bootstrap-probe";
export {
  WINDOWS_BOOTSTRAP_MARKER_FILE,
  windowsBootstrapScript,
  type WindowsBootstrapOptions,
} from "./adapters/bootstrap-windows";
export {
  createWindowsInstanceAdapter,
  type WindowsInstanceDeps,
  type WindowsLaunchSpec,
} from "./adapters/windows-instance";
export {
  fetchWindowsPassword,
  type WindowsPassword,
  type WindowsPasswordInput,
} from "./adapters/windows-access";
export {
  fetchDatabasePassword,
  type DatabasePassword,
  type DatabasePasswordInput,
} from "./adapters/database-access";
export { createBucketAdapter, type BucketDeps } from "./adapters/bucket";
export {
  createBucketAccessKey,
  listBucketAccessKeys,
  type BucketAccessKeyListed,
  type BucketAccessKey,
  type BucketAccessKeyInput,
} from "./adapters/bucket-access";
export { createCdnAdapter, type CdnDeps } from "./adapters/cdn";
export {
  createContainerServiceAdapter,
  type ContainerServiceDeps,
} from "./adapters/container-service";
export {
  createBackupAdapter,
  withBackups,
  type BackupConfig,
  type BackupDeps,
} from "./adapters/backup";
export { createDiskAdapter, parseDiskConfig, type DiskConfig } from "./adapters/disk";
export { LB_INSTANCE_PORT, createLoadBalancerAdapter } from "./adapters/load-balancer";
export {
  MASTER_DATABASE_NAME,
  MASTER_USERNAME,
  createDatabaseAdapter,
  type DatabaseDeps,
  type DatabaseLaunchSpec,
} from "./adapters/database";
export {
  createLinuxInstanceAdapter,
  parsePortRules,
  type LinuxInstanceDeps,
  type LinuxLaunchSpec,
} from "./adapters/linux-instance";
export {
  applyRecordChange,
  createDnsZoneAdapter,
  listZoneRecords,
  type DnsZoneConfig,
  type DnsZoneDeps,
  type RecordChangeInput,
  type ZoneRecordView,
} from "./adapters/dns-zone";
export type { R53Change, R53RecordSet, R53Zone, Route53Port } from "./adapters/route53-port";
export { createRoute53Port, type Route53Like } from "./adapters/route53-client";
export {
  createDomainAdapter,
  recheckRenewal,
  renewDomainOnce,
  resendVerification,
  type DomainAdapterConfig,
  type DomainDeps,
} from "./adapters/domain";
export type {
  ContactReachability,
  DomainAvailability,
  DomainDetail,
  DomainOperationStatus,
  DomainsPort,
} from "./adapters/domains-port";
// WPU-X10: the KMS unseal of the registrant contact (provisioner only; the key is in the control-plane account).
export {
  DOMAIN_CONTACT_CONTEXT,
  createContactUnseal,
  createKmsClient,
  isKmsKeyArn,
  type KmsDecryptSender,
} from "./contact-unseal";
export {
  createRoute53DomainsClient,
  createRoute53DomainsPort,
  type DomainsClientOptions,
  type DomainsSender,
} from "./domains-client";
