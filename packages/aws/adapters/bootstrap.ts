// 10.4 item 1: the bootstrap firewall of a Linux instance, as user data (a fixed template; its inputs
// are a checked CIDR and one boolean, so no customer text can reach it, R11). Lightsail filters only
// the public IP, so this script closes the private network between customers of one pool account.
// VERIFY on every offered blueprint: a blueprint is listed only after its bootstrap passes
// tests/isolation. VERIFY: Lightsail user data runs once at first boot through cloud-init, and its
// size limit; the VPC CIDR of each pool account and Region (expected value below).

export const BOOTSTRAP_EXPECTED_VPC_CIDR = "172.26.0.0/16";
/** What is dropped when no valid CIDR was given: every private (RFC 1918) source. Fails closed. */
export const BOOTSTRAP_FAIL_CLOSED_CIDRS = Object.freeze([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const);
/** Printed by the script, and written to the file, only after the unit started (rules loaded and checked). */
export const BOOTSTRAP_OK_MARKER = "TC_BOOTSTRAP_OK";
export const BOOTSTRAP_MARKER_FILE = "/var/lib/tc-isolation.ok";
/**
 * WPU-G1. Lightsail has no console-output API, so the instance reports its marker itself: a small
 * unit answers every TCP connection on this port with the content of the marker file (empty until
 * the file exists) and closes. Only the platform probe reaches it: the Lightsail firewall opens the
 * port to the probe sources during create and the final port set removes the rule; from the private
 * network the isolation rules drop the connection. VERIFY in tc-pool-dev (python3 on every blueprint).
 */
export const BOOTSTRAP_BEACON_PORT = 52022;

export interface BootstrapOptions {
  /**
   * The verified VPC CIDR, written into the script as a literal. The instance never asks the
   * metadata service at boot and never falls back silently: a missing or invalid value makes the
   * script drop every RFC 1918 source instead.
   */
  readonly vpcCidr?: string | null;
  /**
   * Port 80 from the VPC CIDR, for an instance behind a Lightsail load balancer. Off by default.
   * Needs a valid `vpcCidr`: it is refused (throws) otherwise, so the fail-closed list never opens
   * a port. VERIFY the source addresses of Lightsail load balancers.
   */
  readonly allowLoadBalancerHttp?: boolean;
}

/** A dotted IPv4 CIDR with octets up to 255 and a prefix up to 32. */
export function isValidCidr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (m === null) return false;
  return m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
}

function sourcesOf(options: BootstrapOptions): readonly string[] {
  return isValidCidr(options.vpcCidr) ? [options.vpcCidr] : BOOTSTRAP_FAIL_CLOSED_CIDRS;
}

// The rules script. Its only job is the rules: load, read back, flush the entries of the private
// network. Written by a quoted here-document, so nothing is expanded at install time. Priority -150
// is after connection tracking (-200) and before NAT (-100): ports that Docker publishes are covered.
function rulesScript(options: BootstrapOptions): string {
  const sources = sourcesOf(options);
  const set = sources.join(", ");
  const http =
    options.allowLoadBalancerHttp === true ? `    ip saddr { ${set} } tcp dport 80 accept\n` : "";
  return `#!/bin/bash
set -euo pipefail
nft -f - <<'NFT'
table inet tc_isolation
delete table inet tc_isolation
table inet tc_isolation {
  chain prerouting {
    type filter hook prerouting priority -150; policy accept;
    ct state established,related accept
    udp sport 67 udp dport 68 accept
${http}    ip saddr { ${set} } drop
  }
}
NFT
nft list table inet tc_isolation >/dev/null
command -v conntrack >/dev/null 2>&1 || exit 1
for c in ${sources.join(" ")}; do
  conntrack -D -s "$c" >/dev/null 2>&1 || [ $? -eq 1 ]
done
`;
}

// Before network-pre.target and without default dependencies: the rules load before any interface
// is configured. The mounts that hold the script are required first.
const UNIT = `[Unit]
Description=TiCON tenant isolation firewall
DefaultDependencies=no
After=local-fs.target
RequiresMountsFor=/var/lib /usr/local/sbin
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tc-isolation.sh

[Install]
WantedBy=sysinit.target
`;

// The beacon: answers with the marker file and nothing else. Standard library only.
const BEACON_PY = `import socket
PORT = ${BOOTSTRAP_BEACON_PORT}
MARKER = "${BOOTSTRAP_MARKER_FILE}"
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", PORT))
server.listen(8)
while True:
    conn, _ = server.accept()
    try:
        conn.settimeout(2)
        try:
            with open(MARKER, "rb") as handle:
                data = handle.read(64)
        except OSError:
            data = b""
        conn.sendall(data)
    except OSError:
        pass
    finally:
        conn.close()
`;

const BEACON_UNIT = `[Unit]
Description=TiCON bootstrap beacon
After=tc-isolation.service
Requires=tc-isolation.service

[Service]
ExecStart=/usr/bin/python3 /usr/local/sbin/tc-beacon.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

/**
 * The user data of every Linux instance. Any failure exits non-zero and writes no marker. The marker
 * is a separate last step: if it cannot be written the instance is still isolated, and the control
 * plane reports it as not bootstrapped.
 */
export function bootstrapScript(options: BootstrapOptions = {}): string {
  if (options.allowLoadBalancerHttp === true && !isValidCidr(options.vpcCidr)) {
    throw new Error("bootstrap: port 80 needs a valid VPC CIDR");
  }
  return `#!/bin/bash
set -euo pipefail
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y nftables conntrack
else
  dnf install -y nftables conntrack-tools
fi
command -v nft >/dev/null 2>&1 || exit 1
command -v conntrack >/dev/null 2>&1 || exit 1
install -d /usr/local/sbin
cat > /usr/local/sbin/tc-isolation.sh <<'TC_RULES_EOF'
${rulesScript(options)}TC_RULES_EOF
chmod 0755 /usr/local/sbin/tc-isolation.sh
cat > /etc/systemd/system/tc-isolation.service <<'TC_UNIT_EOF'
${UNIT}TC_UNIT_EOF
systemctl daemon-reload
systemctl enable tc-isolation.service
systemctl start tc-isolation.service
cat > /usr/local/sbin/tc-beacon.py <<'TC_BEACON_EOF'
${BEACON_PY}TC_BEACON_EOF
chmod 0755 /usr/local/sbin/tc-beacon.py
cat > /etc/systemd/system/tc-beacon.service <<'TC_BEACON_UNIT_EOF'
${BEACON_UNIT}TC_BEACON_UNIT_EOF
systemctl daemon-reload
systemctl enable tc-beacon.service
systemctl start tc-beacon.service
sleep 1
systemctl is-active --quiet tc-beacon.service
install -d /var/lib
echo ${BOOTSTRAP_OK_MARKER} > ${BOOTSTRAP_MARKER_FILE}
echo ${BOOTSTRAP_OK_MARKER}
`;
}
