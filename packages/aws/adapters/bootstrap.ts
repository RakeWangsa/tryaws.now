// 10.4 item 1: the bootstrap firewall of a Linux instance, as user data (a fixed template; its only
// input is one boolean, so no customer text can reach it, R11). Lightsail filters only the public IP,
// so this script closes the private network between customers of one pool account.
// VERIFY on every offered blueprint: a blueprint is listed only after its bootstrap passes
// tests/isolation. VERIFY: Lightsail user data runs once at first boot through cloud-init, and its
// size limit.

export const BOOTSTRAP_EXPECTED_VPC_CIDR = "172.26.0.0/16";
/** The last line the script prints, and the file it writes, only after the rules are loaded and checked. */
export const BOOTSTRAP_OK_MARKER = "TC_BOOTSTRAP_OK";
export const BOOTSTRAP_MARKER_FILE = "/var/lib/tc-isolation.ok";

export interface BootstrapOptions {
  /**
   * Port 80 from the VPC CIDR, for an instance behind a Lightsail load balancer (health checks and
   * traffic). Off by default: without it the instance accepts nothing from the private network.
   * VERIFY the source addresses of Lightsail load balancers; until known, the whole CIDR is the only
   * way to express this rule, which is why it is explicit.
   */
  readonly allowLoadBalancerHttp?: boolean;
}

// Written by a quoted here-document, so nothing in it is expanded at install time. Priority -150 is
// after connection tracking (-200) and before NAT (-100): ports that Docker publishes are covered too.
function rulesScript(options: BootstrapOptions): string {
  const http =
    options.allowLoadBalancerHttp === true ? "    ip saddr $CIDR tcp dport 80 accept\n" : "";
  return `#!/bin/bash
set -euo pipefail
rm -f ${BOOTSTRAP_MARKER_FILE}
FALLBACK_CIDR="${BOOTSTRAP_EXPECTED_VPC_CIDR}"
CIDR=""
TOKEN=$(curl -sS -m 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null) || TOKEN=""
if [ -n "$TOKEN" ]; then
  MAC=$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/" 2>/dev/null | head -n 1 | tr -d '/') || MAC=""
  if [ -n "$MAC" ]; then
    CIDR=$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/vpc-ipv4-cidr-block" 2>/dev/null) || CIDR=""
  fi
fi
if ! printf '%s' "$CIDR" | grep -Eq '^[0-9]{1,3}(\\.[0-9]{1,3}){3}/[0-9]{1,2}$'; then
  CIDR="$FALLBACK_CIDR"
fi
nft -f - <<NFT
table inet tc_isolation
delete table inet tc_isolation
table inet tc_isolation {
  chain prerouting {
    type filter hook prerouting priority -150; policy accept;
    ct state established,related accept
    udp sport 67 udp dport 68 accept
${http}    ip saddr $CIDR drop
  }
}
NFT
nft list table inet tc_isolation >/dev/null
if command -v conntrack >/dev/null 2>&1; then
  conntrack -D -s "$CIDR" >/dev/null 2>&1 || true
fi
install -d /var/lib
echo ${BOOTSTRAP_OK_MARKER} > ${BOOTSTRAP_MARKER_FILE}
`;
}

// Before network-pre.target and without default dependencies: the rules load before any interface
// is configured, so there is no window at boot in which the private network is open.
const UNIT = `[Unit]
Description=TiCON tenant isolation firewall
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tc-isolation.sh

[Install]
WantedBy=sysinit.target
`;

/** The user data of every Linux instance. Any failure exits non-zero and writes no marker. */
export function bootstrapScript(options: BootstrapOptions = {}): string {
  return `#!/bin/bash
set -euo pipefail
if ! command -v nft >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y nftables conntrack
  else
    dnf install -y nftables conntrack-tools
  fi
fi
command -v nft >/dev/null 2>&1 || exit 1
install -d /usr/local/sbin
cat > /usr/local/sbin/tc-isolation.sh <<'TC_RULES_EOF'
${rulesScript(options)}TC_RULES_EOF
chmod 0755 /usr/local/sbin/tc-isolation.sh
cat > /etc/systemd/system/tc-isolation.service <<'TC_UNIT_EOF'
${UNIT}TC_UNIT_EOF
systemctl daemon-reload
systemctl enable tc-isolation.service
systemctl start tc-isolation.service
test -s ${BOOTSTRAP_MARKER_FILE}
echo ${BOOTSTRAP_OK_MARKER}
`;
}
