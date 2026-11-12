// WP0-T2: VPC with two AZs and managed NAT (3.3), the security groups of the data path, and the two
// isolated subnets of invoice-renderer.
//
// NOT TYPE-CHECKED: SST is not installed in this repository yet (JOURNEY.md, first manual step), so
// `sst`, `aws` and `$output` are undeclared globals here. ESLint parses the file, Prettier formats it,
// and tests/repo/infra-rules.test.mjs reads the text. Every detail the SST and Pulumi documents did
// not confirm is marked `VERIFY:` and listed in JOURNEY.md.
import { AZ_COUNT, VPC_CIDR, isolatedSubnets } from "../lib/network";
import { sizing } from "../lib/lean";
import { REGION, resourceName, type StageConfig } from "../lib/stage";

export function network(config: StageConfig) {
  const stage = config.stage;

  // az: 2 is documented (sst.aws.Vpc: az default 2). nat comes from the stage size (WPU-B8): "managed"
  // (a NAT gateway per AZ) in full, "ec2" (a NAT instance) in lean.
  // VERIFY: sst.aws.Vpc nat: "ec2" makes one instance for the whole VPC or one per AZ, its default
  // instance type, and that the private route tables of both AZs point at it; TC_PROBE_SOURCES must
  // then list the address(es) of the instance(s) (max 10, one is fine).
  const vpc = new sst.aws.Vpc("Vpc", {
    az: AZ_COUNT,
    nat: sizing(config.size, config.kind).network.nat,
    transform: {
      vpc: (args: { cidrBlock?: string }) => {
        // VERIFY: transform.vpc is listed in the docs; that aws.ec2.Vpc cidrBlock set here is honoured
        // by the component's subnet layout (it may compute subnets from its own default 10.0.0.0/16).
        args.cidrBlock = VPC_CIDR[config.kind];
      },
    },
  });

  const egressAll = [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }];

  // Security group of every Lambda in the app subnets: no inbound, outbound to NAT (EPS, AWS APIs, SMS).
  const appSecurityGroup = new aws.ec2.SecurityGroup("AppSecurityGroup", {
    vpcId: vpc.id,
    name: resourceName(stage, "app-sg"),
    description: "Lambda functions in the VPC",
    egress: egressAll,
  });

  // Database path: functions -> proxy -> instance. 5432 is admitted only from the previous hop.
  const proxySecurityGroup = new aws.ec2.SecurityGroup("ProxySecurityGroup", {
    vpcId: vpc.id,
    name: resourceName(stage, "proxy-sg"),
    description: "RDS Proxy",
  });
  const databaseSecurityGroup = new aws.ec2.SecurityGroup("DatabaseSecurityGroup", {
    vpcId: vpc.id,
    name: resourceName(stage, "db-sg"),
    description: "RDS instance",
  });
  // Separate rule resources, so the proxy -> database pair has no dependency cycle.
  // VERIFY: aws.vpc.SecurityGroupIngressRule / EgressRule names and fields in Pulumi AWS v7.
  new aws.vpc.SecurityGroupIngressRule("ProxyFromApp", {
    securityGroupId: proxySecurityGroup.id,
    referencedSecurityGroupId: appSecurityGroup.id,
    ipProtocol: "tcp",
    fromPort: 5432,
    toPort: 5432,
  });
  new aws.vpc.SecurityGroupEgressRule("ProxyToDatabase", {
    securityGroupId: proxySecurityGroup.id,
    referencedSecurityGroupId: databaseSecurityGroup.id,
    ipProtocol: "tcp",
    fromPort: 5432,
    toPort: 5432,
  });
  new aws.vpc.SecurityGroupIngressRule("DatabaseFromProxy", {
    securityGroupId: databaseSecurityGroup.id,
    referencedSecurityGroupId: proxySecurityGroup.id,
    ipProtocol: "tcp",
    fromPort: 5432,
    toPort: 5432,
  });
  // The migrator runs as a function in the app subnets and reaches the proxy like any other function.

  // invoice-renderer: two isolated subnets without a NAT route (3.3), S3 only through a gateway endpoint.
  // VERIFY: sst.aws.Vpc has no isolated subnet type, so these are raw subnets in the high octets
  // (200 and 201) that the component's own layout should not use.
  const isolated = isolatedSubnets(config.kind).map(
    (plan, index) =>
      new aws.ec2.Subnet(`IsolatedSubnet${index}`, {
        vpcId: vpc.id,
        availabilityZone: plan.az,
        cidrBlock: plan.cidr,
        mapPublicIpOnLaunch: false,
      }),
  );
  const isolatedRouteTable = new aws.ec2.RouteTable("IsolatedRouteTable", { vpcId: vpc.id });
  isolated.forEach(
    (subnet, index) =>
      new aws.ec2.RouteTableAssociation(`IsolatedAssociation${index}`, {
        subnetId: subnet.id,
        routeTableId: isolatedRouteTable.id,
      }),
  );
  const s3Endpoint = new aws.ec2.VpcEndpoint("S3GatewayEndpoint", {
    vpcId: vpc.id,
    serviceName: `com.amazonaws.${REGION}.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds: [isolatedRouteTable.id],
  });
  const isolatedSecurityGroup = new aws.ec2.SecurityGroup("IsolatedSecurityGroup", {
    vpcId: vpc.id,
    name: resourceName(stage, "isolated-sg"),
    description: "invoice-renderer: HTTPS to S3 only",
    // VERIFY: VpcEndpoint.prefixListId is the S3 prefix list that a security group egress rule accepts.
    egress: [
      {
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        prefixListIds: [s3Endpoint.prefixListId],
      },
    ],
  });

  return {
    vpc,
    appSecurityGroup,
    proxySecurityGroup,
    databaseSecurityGroup,
    isolatedSecurityGroup,
    isolatedSubnetIds: isolated.map((subnet) => subnet.id),
  };
}

export type Network = ReturnType<typeof network>;
