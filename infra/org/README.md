# infra/org: organization templates for DevOps

Task WP0-T5. Plain CloudFormation YAML. **Authored only.** Claude Code never applies, validates against AWS or runs any of this, and never holds credentials for the management account. DevOps applies it with a person's role, in the order below. The SST app (`sst.config.ts`, `infra/stacks`) is separate and does not touch these files.

Rules behind it: R1 (web and admin cannot assume any pool role), R3 (no long-lived keys, STS only), R16 (fail closed), Section 3.1 (accounts), 3.3 (CloudTrail, GuardDuty), 6.3 (roles), 15 (security gate).

No account id, ARN of a real account, email, phone number or secret appears here. Account ids are CloudFormation parameters that DevOps types at deploy time. A test (`tests/repo/infra-org.test.mjs`) fails on a 12-digit number in this folder.

## Files

| File                                           | Account                               | Purpose                                                                                 |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `accounts-and-ous.md`, `accounts-and-ous.yaml` | management                            | OU layout, account checklist, the six OUs                                               |
| `scps.yaml`                                    | management                            | Guardrails, pool allow-list, DNS allow-list                                             |
| `pool-roles.yaml`                              | each pool account                     | `TcProvisioner`, `TcReader`, `TcAccessDetails`, `TcBillingReader`, permissions boundary |
| `dns-account.yaml`                             | `tc-dns`                              | `TcDnsProvisioner`, `TcDnsReader`, `TcBillingReader`, boundary                          |
| `cloudtrail-log-bucket.yaml`                   | log archive                           | KMS key and the log bucket that nobody can delete from                                  |
| `cloudtrail-trail.yaml`                        | management                            | The organization trail                                                                  |
| `guardduty.yaml`                               | log archive (delegated administrator) | Detector per Region, high severity findings to on-call                                  |
| `alternate-contacts.template.sh`               | management                            | Security alternate contact of every account (dry run by default)                        |
| `ISOLATION.md`                                 | none                                  | Plan of the manual isolation test in `tc-pool-dev`                                      |

## Order of application

Every step: a named person, a session in the AWS console or CLI with a role (IAM Identity Center), the root user never. Write the date and the person in the table at the end.

1. `accounts-and-ous.md` steps 1 to 6: quota, six OUs (`accounts-and-ous.yaml`), the seven accounts, root MFA, trusted access.
2. In each pool account, before the pool SCP is attached: create and delete one Lightsail bucket as the admin role, so Lightsail creates its service-linked role (6.3).
3. `cloudtrail-log-bucket.yaml` in the log archive account (Region `ap-southeast-1`). Note the bucket name and the key ARN.
4. `cloudtrail-trail.yaml` in the management account, same Region. Check that the first log file arrives and that `LogFileValidationEnabled` is true.
5. GuardDuty:
   1. In the management account, for each approved Region, name the log archive account as the GuardDuty delegated administrator (`aws guardduty enable-organization-admin-account`).
   2. In the log archive account, deploy `guardduty.yaml` in each approved Region (needs an SNS topic for on-call in that Region).
   3. In the log archive account, for each Region, set auto-enable for all organization members (`aws guardduty update-organization-configuration` with `--auto-enable-organization-members ALL`).
   4. `aws guardduty list-members` shows every account enabled.
6. `scps.yaml` in the management account. Use the OU ids of step 1, the root id, the log bucket name and the key id (the part after `key/` of the key ARN) of step 3. The SCP `ticon-log-protection` denies every change of the bucket policy, Object Lock and key for everyone, root included; the break-glass path is detaching that SCP in the management account, which is logged by the organization trail. **Attach to `TiCON-Pools-Dev` first**, run the checks of the VERIFY comment at the top of the file, then attach to the production pool OUs and `TiCON-Dns`.
7. `pool-roles.yaml` in `tc-pool-dev` with the account id of `tc-platform-stg` and a new ExternalId. Repeat in `tc-pool-v1` and `tc-pool-n1` with the account id of `tc-platform`. Deploy it with the admin role, not as a StackSet: the SCPs have no exemption for a StackSet execution role. The ExternalId must differ per account.
8. `dns-account.yaml` in `tc-dns` with the account id of `tc-platform`.
9. `alternate-contacts.template.sh`: dry run first, then `--apply`. Needs the five environment variables at the top of the script.
10. Record the ExternalId of each pool account and the account ids in the admin app `/capacity` (`addPoolAccount`), as in `docs/runbooks/pool-account-onboarding.md` step 7.
11. Staging proof: from the staging `provisioner` function role, assume `TcProvisioner` in `tc-pool-dev` (works); from the staging `web` function role the same call must be denied (this is the manual twin of the static test).
12. `ISOLATION.md`: the manual isolation test in `tc-pool-dev`.

The function role names are `tc-<stage>-<function>-role` (`roleName` in `infra/lib/stage.ts`, applied by `infra/stacks/workers.ts`), for example `tc-staging-provisioner-role`. `pool-roles.yaml` and `dns-account.yaml` build them from the parameter `ControlPlaneStage` (`staging` for `tc-pool-dev`, `production` for the customer pools and `tc-dns`), so the trust names the roles SST really creates. A repo test pins this against the function table. No name is a parameter any more; a changed name in `infra/lib/stage.ts` fails that test.

## Pool account added later (runbook)

`docs/runbooks/pool-account-onboarding.md` lists the steps for one new pool account. In terms of this folder: create the account in `TiCON-Pools` (steps 1 and 2 above), `pool-roles.yaml` (step 7), `alternate-contacts.template.sh`, then `/capacity`. The SCPs, the organization trail and GuardDuty apply by themselves through the OU and the organization settings.

## Needs DevOps confirmation

Each line is a statement that only a person with the AWS accounts can confirm. The column stays empty until that person writes in `JOURNEY.md`, in the entry "WP0-T5 DevOps confirmation". Nothing in the repository fills it.

| Statement                                                                                                                             | Confirmed by, date |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| The six OUs and the seven accounts exist as in `accounts-and-ous.md`                                                                  |                    |
| The organization trail delivers logs with validation and KMS                                                                          |                    |
| GuardDuty is enabled in every account in every approved Region                                                                        |                    |
| SCPs attached; in `tc-pool-dev` `TcProvisioner` creates an instance and a bucket, and a denied action is refused (Section 15 item 13) |                    |
| `TcAccessDetails` returns a Windows password for a tagged Windows instance and is refused for a Linux one                             |                    |
| The staging web function role cannot assume `TcProvisioner`                                                                           |                    |
| Every pool account and `tc-dns` has the security alternate contact                                                                    |                    |
| The isolation test of `ISOLATION.md` passed in each launch Region                                                                     |                    |

## VERIFY list

Every `# VERIFY:` comment in the templates is a detail not checked against a live account. `tests/repo/infra-org.test.mjs` counts them so that none disappears silently.
