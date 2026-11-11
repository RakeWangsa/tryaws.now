// 10.4 item 1: the bootstrap firewall of a Linux instance, as user data (a fixed template; it takes
// no input, so no customer text can reach it, R11). Lightsail filters only the public IP, so this
// script closes the private network between customers of one pool account. VERIFY on every offered
// blueprint: a blueprint is listed only after its bootstrap passes tests/isolation.

export const BOOTSTRAP_EXPECTED_VPC_CIDR = "172.26.0.0/16";

// Written by a quoted here-document, so nothing in it is expanded at install time. Priority -150 is
// after connection tracking (-200) and before NAT (-100): ports that Docker publishes are covered too.
const RULES_SCRIPT = `#!/bin/bash
set -u
FALLBACK_CIDR="${BOOTSTRAP_EXPECTED_VPC_CIDR}"
CIDR=""
TOKEN=$(curl -sS -m 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  MAC=$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/" 2>/dev/null | head -n 1 | tr -d '/' || true)
  if [ -n "$MAC" ]; then
    CIDR=$(curl -sS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/$MAC/vpc-ipv4-cidr-block" 2>/dev/null || true)
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
    ip saddr $CIDR tcp dport 80 accept
    ip saddr $CIDR drop
  }
}
NFT
`;

const UNIT = `[Unit]
Description=TiCON tenant isolation firewall
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tc-isolation.sh

[Install]
WantedBy=multi-user.target
`;

/** The user data of every Linux instance. */
export function bootstrapScript(): string {
  return `#!/bin/bash
set -u
if ! command -v nft >/dev/null 2>&1; then
  (apt-get update -y && apt-get install -y nftables) >/dev/null 2>&1 || dnf install -y nftables >/dev/null 2>&1 || true
fi
install -d /usr/local/sbin
cat > /usr/local/sbin/tc-isolation.sh <<'TC_RULES_EOF'
${RULES_SCRIPT}TC_RULES_EOF
chmod 0755 /usr/local/sbin/tc-isolation.sh
cat > /etc/systemd/system/tc-isolation.service <<'TC_UNIT_EOF'
${UNIT}TC_UNIT_EOF
systemctl daemon-reload
systemctl enable --now tc-isolation.service
`;
}
