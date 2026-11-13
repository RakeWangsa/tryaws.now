// WP0-T2: VPC with two AZs and the NAT of the stage size (3.3, WPU-B8, WPU-Z10), the security groups of
// the data path, and the two isolated subnets of invoice-renderer.
//
// NOT TYPE-CHECKED unless `.sst/platform/config.d.ts` exists: `sst`, `aws`, `$util` and `$output`
// are globals that `sst install` declares there (git-ignored, absent in CI). Where it exists,
// tests/repo/sst-types.test.mjs runs `tsc -p infra/tsconfig.stacks.json` against the SST 4.17.2
// and Pulumi AWS 7.20.0 types (WPU-Z9). ESLint parses the file, Prettier formats it, and
// tests/repo/infra-rules.test.mjs reads the text. Every detail the SST and Pulumi documents did not
// confirm is marked `VERIFY:` and listed in JOURNEY.md.
import { NAT_INSTANCE, sizing, sstNatOf } from "../lib/lean";
import { AZ_COUNT, VPC_CIDR, isolatedSubnets, rebaseSubnetCidr } from "../lib/network";
import { REGION, resourceName, type StageConfig } from "../lib/stage";

// The callback form of SST's Transform<T> (.sst/platform/src/components/component.ts): it changes the
// arguments in place and returns undefined. A callback built away from its call site needs it.
type TransformFn<T> = (args: T) => undefined;

// A value that is made later than the code that needs it: a promise resolved once (see lean NAT below).
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// WPU-Z10 (lean, requirement 1): ONE NAT instance for the whole VPC. VERIFY result (SST 4.17.2 vpc.ts,
// and docs/analysis/verify-review-2026-11-13.md, B1 infra/stacks/network.ts:17, lines 132 to 142):
// sst.aws.Vpc `nat: "ec2"` launches a t4g.nano fck-nat instance and an Elastic IP in EACH AZ and routes
// each private subnet to the instance of its own AZ, so two of each. A lean stage asks SST for no NAT
// (sstNatOf) and builds the single one here: the image choice SST makes (NAT_INSTANCE), in the public
// subnet of the first AZ, with one Elastic IP. The private route tables of BOTH AZs send 0.0.0.0/0 to
// its network interface (the transform in network() below); the isolated subnets of invoice-renderer get
// no route to it. Inbound only from the VPC, outbound anywhere. No IAM role and no key pair: NAT needs
// neither (SST's role carries only SSM access). One instance is one point of failure for outbound
// traffic; the lean runbook accepts that (docs/runbooks/single-account-lean.md).
// A deploy can replace the instance when a newer fck-nat image is published (mostRecent, as in SST);
// the Elastic IP is a separate resource, so the address (TC_PROBE_SOURCES) stays.
function singleNatInstance(config: StageConfig, vpc: sst.aws.Vpc) {
  const stage = config.stage;
  const ami = aws.ec2.getAmiOutput({
    owners: [NAT_INSTANCE.amiOwner],
    filters: [
      { name: "name", values: [NAT_INSTANCE.amiName] },
      { name: "architecture", values: [NAT_INSTANCE.architecture] },
    ],
    mostRecent: true,
  });
  const securityGroup = new aws.ec2.SecurityGroup("NatSecurityGroup", {
    vpcId: vpc.id,
    name: resourceName(stage, "nat-sg"),
    description: "NAT instance: inbound from the VPC only, outbound to the internet",
    ingress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: [VPC_CIDR[config.kind]] }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  });
  const instance = new aws.ec2.Instance("NatInstance", {
    instanceType: NAT_INSTANCE.type,
    ami: ami.id,
    // The public subnet of the first AZ; fail closed (R16) if SST built none.
    subnetId: vpc.nodes.publicSubnets.apply((subnets) => {
      const subnet = subnets[0];
      if (subnet === undefined)
        throw new Error("the VPC has no public subnet for the NAT instance");
      return subnet.id;
    }),
    vpcSecurityGroupIds: [securityGroup.id],
    // A NAT forwards traffic that is neither from nor to itself.
    sourceDestCheck: false,
    tags: { Name: resourceName(stage, "nat") },
  });
  const elasticIp = new aws.ec2.Eip("NatElasticIp", {
    domain: "vpc",
    tags: { Name: resourceName(stage, "nat-ip") },
  });
  new aws.ec2.EipAssociation("NatElasticIpAssociation", {
    instanceId: instance.id,
    allocationId: elasticIp.allocationId,
  });
  return { instance, elasticIp, securityGroup };
}

export function network(config: StageConfig) {
  const stage = config.stage;
  const nat = sizing(config.size, config.kind).network.nat;

  // WPU-Z10, VERIFY review 2026-11-13 (B1 infra/stacks/network.ts:25, lines 144 to 154): SST 4.17.2
  // vpc.ts lays out its public and private subnets in 10.0.x.x whatever the VPC CIDR, so each one is
  // rebased onto the stage's /16 (infra/lib/network.ts rebaseSubnetCidr, fail closed). SST passes the
  // CIDR as a plain string; anything else stops the deploy.
  const rebase: TransformFn<aws.ec2.SubnetArgs> = (args) => {
    if (typeof args.cidrBlock !== "string") {
      throw new Error("the SST subnet CIDR is not a plain string: check vpc.ts of the SST version");
    }
    args.cidrBlock = rebaseSubnetCidr(args.cidrBlock, config.kind);
  };

  // Lean: the private route tables are created inside the Vpc component and need the network interface
  // of the single NAT instance, and that instance needs a public subnet of the same VPC. The route takes
  // the interface from a promise that is resolved right after the instance exists, so it does not matter
  // when SST calls the transform (in 4.17.2 it does so inside an apply, vpc.ts createPrivateSubnets).
  // VERIFY (first `sst diff` of a lean stage): both private route tables show 0.0.0.0/0 to the NAT
  // instance's network interface, and the isolated route table shows no default route.
  const natInterface = deferred<$util.Output<string>>();
  const routeToSingleNat: TransformFn<aws.ec2.RouteTableArgs> = (args) => {
    args.routes = [{ cidrBlock: "0.0.0.0/0", networkInterfaceId: $output(natInterface.promise) }];
  };

  // az: 2 is documented (sst.aws.Vpc: az default 2). The NAT comes from the stage size: "managed" (a NAT
  // gateway and an Elastic IP per AZ, SST's own routes) in full, the single instance above in lean.
  const vpc = new sst.aws.Vpc("Vpc", {
    az: AZ_COUNT,
    nat: sstNatOf(nat),
    transform: {
      // Transform<ec2.VpcArgs>, as SST passes it (.sst/platform/src/components/aws/vpc.ts).
      // VERIFY result (WPU-Z9): transform.vpc exists (`vpc?: Transform<ec2.VpcArgs>`); the subnets are
      // rebased above because the component does not derive them from this CIDR.
      vpc: (args: aws.ec2.VpcArgs) => {
        args.cidrBlock = VPC_CIDR[config.kind];
      },
      publicSubnet: rebase,
      privateSubnet: rebase,
      ...(nat === "single-instance" ? { privateRouteTable: routeToSingleNat } : {}),
    },
  });
  const singleNat = nat === "single-instance" ? singleNatInstance(config, vpc) : undefined;
  if (singleNat !== undefined) natInterface.resolve(singleNat.instance.primaryNetworkInterfaceId);

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
