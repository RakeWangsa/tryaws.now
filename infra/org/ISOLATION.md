# Isolation of customers inside a pool account (test plan)

Source: Section 10.4, WP4-T6, Section 15 item 12. Code: `packages/aws/adapters/bootstrap.ts` (Linux), `packages/aws/adapters/bootstrap-windows.ts` (Windows). Test: `tests/isolation/` (cases in `cases.ts`).

## Why this belongs next to the organization templates

Customers of one pool account share one Lightsail VPC per Region (expected CIDR `172.26.0.0/16`, `BOOTSTRAP_EXPECTED_VPC_CIDR`). Lightsail filters only the public IP, so two customers' instances can reach each other on private addresses unless the instance itself blocks it. The platform closes that with the bootstrap firewall in user data. The templates in this folder add the account-level half of the same promise:

| Expectation                                                                              | Where it is enforced                                                                              | Template                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| No VPC peering from a pool account to anything else                                      | `lightsail:PeerVpc` and `UnpeerVpc` are denied in the permissions boundary and in `TcProvisioner` | `pool-roles.yaml`              |
| No default key pair download, no snapshot export, no CloudFormation stack from Lightsail | explicit deny in the boundary and in `TcProvisioner`                                              | `pool-roles.yaml`              |
| Only the three Lightsail Regions                                                         | `DenyRegionsThatAreNotApproved` SCP and the Region condition in every role                        | `scps.yaml`, `pool-roles.yaml` |
| No other service in a pool account (no EC2 of our own to bypass the pool)                | pool SCP allow-list                                                                               | `scps.yaml`                    |
| The instance blocks private sources by itself                                            | bootstrap script (fails closed to all RFC 1918 sources when the CIDR is unknown)                  | `packages/aws`                 |

The first four rows are static. The last row needs a real pool account.

## MANUAL: the real test (needs `tc-pool-dev`)

Not run by Claude Code, not run in CI. A person with a staging session does this once per launch Region and per offered blueprint, before the blueprint is listed (10.4 item 1).

1. Staging only. Two test customers, A and B, each with one instance in `tc-pool-dev` in the Region under test, created through the staging control plane (so the bootstrap runs as in production).
2. Set `TC_ISOLATION_POOL=tc-pool-dev`, `TC_ISOLATION_A_PRIVATE_IP`, `TC_ISOLATION_B_SSH`, `TC_ISOLATION_B_KEY_FILE` (a path, never the key content).
3. Run `tests/isolation` (the real-pool part skips itself when these are missing).
4. Cases that the script runs: B cannot open tcp 22, 443, 3306 and a high port on A's private IP; tcp 80 is recorded (closed by default, open only on an instance created with the load balancer option).
5. Cases by hand (`MANUAL_CASES` in `cases.ts`): UDP, a Docker published port, load balancer health check, DHCP renewal after a reboot, IPv6 in both directions.
6. Record in `JOURNEY.md`: Region, blueprint, date, who, result of each case. A failed case blocks the blueprint (R16).

## What the static tests of this folder prove, and what they do not

They prove that the denies listed above are in the templates. They do not prove that AWS accepts the templates, that Lightsail honours the condition keys, or that an instance is isolated. Those are VERIFY lines for DevOps and for the manual test above.
