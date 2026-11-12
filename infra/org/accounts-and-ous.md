# Accounts and OUs

Source: Section 3.1 (accounts), 3.3 (CloudTrail and GuardDuty in every account), `docs/runbooks/pool-account-onboarding.md`.
Applied by DevOps in the management account. Claude Code does none of it and never holds management credentials.

## Layout

```
Root (management account: Organizations, SCPs, billing, Lightsail Partner enrollment; no workloads)
  TiCON-Security          tc-log-archive   (PROPOSED, see "Needs decision": log bucket, KMS key, GuardDuty delegated admin)
  TiCON-Platform-Prod     tc-platform      production control plane
  TiCON-Platform-Staging  tc-platform-stg  staging control plane
  TiCON-Dns               tc-dns           Route 53 zones and domain registrations
  TiCON-Pools             tc-pool-v1       trusted customers
                          tc-pool-n1       new customers
                          tc-pool-n2 ...   later cohorts: a configuration change, not a code change (3.1)
  TiCON-Pools-Dev         tc-pool-dev      staging and tests, never production
```

`accounts-and-ous.yaml` creates the six OUs. Accounts are not created by a template: the owner decides on each account, the Organizations account quota (default 10) may need a request, and an account name is permanent for practical purposes.

## Checklist (in order)

1. Management account: sign in with a named administrator role (IAM Identity Center). Never use the root user; never create an access key.
2. Check the Organization account quota against the number of accounts above (7 plus the management account, plus pools to come). Open an AWS Support case first if it is too low.
3. Deploy `accounts-and-ous.yaml` (stack in `us-east-1`). Note the six OU ids from the outputs.
4. Create each account with a unique mailbox of TiCON (an alias such as `aws+tc-pool-v1@`, written by DevOps, not in this repository) and the role name `OrganizationAccountAccessRole` removed or restricted after setup. Place the account in its OU.
5. For every account: set the root user MFA, remove the root access keys if any, and record the account alias (not the id) in the shared notes.
6. Enable trusted access for the services used in this folder: CloudTrail, GuardDuty, AWS Account Management (alternate contacts), and (optional) CloudFormation StackSets.
7. In each pool account, before the pool SCP is attached: create and delete one Lightsail bucket as the DevOps admin role, so Lightsail creates its service-linked role (6.3). `TcProvisioner` cannot create it.
8. Continue with `scps.yaml`, then the files in the order of `README.md`.

## Needs decision

- Section 3.1 lists no log archive account. This folder proposes `tc-log-archive` for the CloudTrail bucket, its KMS key and the GuardDuty delegated administrator, so that no platform account can edit the audit trail. If the owner prefers `tc-platform`, change `LogBucket` parameters only; the SCPs stay the same.
- The pool OU is flat (`TiCON-Pools`). A second OU per cohort is possible later without changing a template.
