# Go-live in one account (WPU-Z11)

Rules: R3 (no long-lived AWS keys; CI uses GitHub OIDC), R12 (every product flag stays off: buying is off at go-live), R16 (fail closed), and the CLAUDE.md rules "never deploy production by hand" and "never touch the management account". Owner decision of 2026-11-13: staging and production live in the SAME member account (the owner's AWS profile `your-aws-profile`), the full platform goes live at `tryaws.now` through the protected CI job, and buying stays off.

What the controller did already (2026-11-13): the SES identity `tryaws.now` is verified; every GitHub environment variable of `staging`, `production` and `production-plan` is set (account, domains `staging.tryaws.now` / `admin-staging.tryaws.now` and `tryaws.now` / `admin.tryaws.now`, admin allowlist, alarm e-mails, `TC_PROBE_SOURCES=198.51.100.1/32` until the NAT address is known, `TC_VPC_CIDR=172.26.0.0/16`, `TC_STAGE_SIZE=lean`, the SES values and the three CI role ARNs of `TcCiDeployStaging`, `TcCiPlanProduction` and `TcCiDeployProduction`); the environment `production` accepts deployments only from tags `v*`.

Isolation in the one account is a policy guard, not an account wall. Each CI deploy role creates and changes IAM roles only under its own stage's names, and is denied what SST tags for the other stage and the other stage's role, function, log, bucket, state, passphrase, parameter, secret, queue, topic, table, database, schedule, alarm, key-alias, budget, CloudFront Function and WAF names. Every role a stage creates carries that stage's permissions boundary (`TcCiRoleBoundaryStaging` or `TcCiRoleBoundaryProduction`) with the same kind of deny. Neither role may change the shared SST bootstrap (`/sst/bootstrap`, the `sst-state-*` and `sst-asset-*` buckets). Known residuals (Needs decision of WPU-Z11): CloudFront distributions, the response headers policy `tc-<stage>-security-headers` and KeyValueStores (id-based ARNs; a KeyValueStore takes no tags; whether CloudFront evaluates the `sst:stage` tag on distributions is a VERIFY), ACM certificates (random ids, tag guard only), the SES identity `tryaws.now` that both stages share (`ses:*`), and the shared SST asset bucket `sst-asset-*`: function code objects have keys without the stage, so either deploy role can overwrite the code the other stage deploys. A staging deploy role can technically reach those of production. Neither deploy role may create or use an S3 access point, so the name-based object denies cannot be bypassed that way. Therefore separate accounts for staging and production remain the stronger option, and the way back is the three-account design of [single-account-lean.md](single-account-lean.md).

## Trigger

The owner decides to put the platform live, or to repeat a step of this page after a change of the CI roles, the secrets or the domains.

## Who

The owner, in their own terminal and on GitHub. A Claude Code session never runs these scripts, never runs `sst secret`, never deploys a stage and never sees a secret value.

## Steps

Each step names the exact command. Run them in order, from the repository folder.

1. **Push main.** The merged work must be on GitHub: `git switch main && git pull --ff-only && git push origin main`.
2. **Load the AWS keys** of the profile into this terminal only (the JOURNEY.md pattern; SST cannot read an `aws login` profile, and nothing may fall back to another profile):

   ```bash
   aws login --profile your-aws-profile
   CREDS="$(aws configure export-credentials --profile your-aws-profile --format env)" && eval "$CREDS"
   export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
   unset AWS_PROFILE CREDS
   aws sts get-caller-identity --query Account --output text
   ```

   The last command must print the account of the platform (a member account, never the management account). Close the terminal at the end of the session; the keys are temporary and never written to a file.

3. **CI roles.** `gh auth status` must show the owner, then run `scripts/golive/ci-roles.sh`. It refuses when the credentials do not work or belong to the management account. It reads the GitHub owner and repository ids with `gh api repos/bemoshiur/tryaws.now` (GitHub signs the immutable OIDC subject `repo:bemoshiur@<owner id>/tryaws.now@<repo id>:environment:<name>` for this repository; without `gh`, export `TC_GITHUB_OWNER_ID` and `TC_GITHUB_REPO_ID` from `gh api repos/bemoshiur/tryaws.now --jq '.owner.id,.id'` on another machine). It deploys `infra/org/ci-oidc-provider.yaml` only when `aws iam list-open-id-connect-providers` shows none for `token.actions.githubusercontent.com` (an account holds one provider per URL; the role templates build its ARN themselves), then `tc-ci-deploy-staging`, `tc-ci-plan-production` and `tc-ci-deploy-production`. It prints only stack names and statuses; each must end `CREATE_COMPLETE` or `UPDATE_COMPLETE`. A `FAILED` line: open the stack events in the CloudFormation console, fix by pull request, run the script again.
4. **Pool and DNS roles** (once, if not done yet): follow [single-account-lean.md](single-account-lean.md) "Role stacks in the one account" with `ControlPlaneStage=production`. The pool and DNS roles trust one stage; with `production` the staging functions cannot provision, which is fine because buying is off.
5. **GitHub environment `production`.** Deployments only from tags `v*` (set on 2026-11-13; check it under Settings, Environments). Required reviewers are not available for a private repository on the owner's GitHub plan, so **pushing the `v*` tag IS the approval** of the production deploy: anyone with write access to the repository who pushes a `v*` tag deploys production (the tag commit must be on `main`, and the workflow checks that). Today the owner is the only person with write access. If the GitHub plan offers tag rulesets for this repository, add one that lets only the owner create `v*` tags; otherwise this is an accepted risk, and every new collaborator with write access can deploy production. GitHub Pro (or a public repository) adds a required-reviewer gate on `production`; add the owner as reviewer then. The environment `production-plan` has the same `v*` tag policy.
6. **Secrets of both stages.** `scripts/golive/stage-secrets.sh staging`, then `scripts/golive/stage-secrets.sh production`. Each sets every secret of `infra/lib/functions.ts` (`ALL_SECRETS` and the five database passwords): random values for the internal keys and the database passwords, the Gennet API token through a hidden prompt, the SMS sender id through a visible prompt, and each EPS value through a hidden prompt where an empty answer stores `not-configured` (the platform then has no EPS: every top-up says "not available" and nothing is sent to EPS). A name that already has a value is skipped (on staging `SmsApiKey` and `SmsSenderId` were set on 2026-11-13); `--force` replaces. The production run also writes the SST passphrase `/sst/passphrase/ticon-cloud/production` and, together with the staging run, `/sst/bootstrap`, which the read-only plan role needs and cannot write. The bootstrap is shared by both stages and no CI role may change it: after an SST upgrade, run one SST command with administrator credentials (for example `scripts/golive/stage-secrets.sh staging`, which skips the set names) before the next CI deploy, so SST bootstraps again.
7. **Staging test session.**
   1. Start the deploy: `gh workflow run deploy-staging.yml --ref main -f gate=M0`, then `gh run watch`. The job summary shows the `sst diff`.
   2. Smoke checks: `curl -sS -o /dev/null -w '%{http_code}\n' https://staging.tryaws.now/bn` prints `200`; `https://staging.tryaws.now/dev/ui` answers `404`; `https://admin-staging.tryaws.now/` answers from an allowlisted address only; sign up with a test e-mail (the code e-mail arrives from `tryaws.now`) and a test phone (the OTP SMS arrives); the wallet top-up page says top-up is not available (EPS `not-configured`); every product page says it is not open (flags off).
   3. Remove the stage when the session ends (cost): run the workflow `remove-staging.yml` from the Actions tab (Task 10 adds it), then `gh run watch`. The data stores of staging are retained by the removal policy.
8. **Production.** On `main`, after the staging session passed: `git tag -a v0.1.0 -m "First production deploy"` and `git push origin v0.1.0`. The workflow `deploy-production.yml` runs `verify` (gate M5), `plan` (read-only `sst diff` in the job summary) and `deploy`. Read the plan summary; the pushed tag is the approval (step 5), so stop the run in the Actions tab if the plan shows anything unexpected. `gh run watch` until the post-deploy check ends `PASS`.
9. **After the first production deploy.**
   1. NAT address: in the EC2 console (Region `ap-southeast-1`), read the public IPv4 address of the NAT instance of the production VPC. Put it into the variable `TC_PROBE_SOURCES` of the environment `production` as `<address>/32` (`gh variable set TC_PROBE_SOURCES --env production --body '<address>/32'`) and redeploy with the next tag (`git tag -a v0.1.1 -m "Probe source" && git push origin v0.1.1`). Until then no Linux create can be probed (buying is off anyway).
   2. First admin with TOTP (a CLI step: the admin app refuses NEW_PASSWORD_REQUIRED and MFA_SETUP). The admin pool id is the output `adminPoolId` of the deploy job. Create the user without a message: `aws cognito-idp admin-create-user --user-pool-id <adminPoolId> --username <owner e-mail> --message-action SUPPRESS`. Set a permanent password typed at a hidden prompt: `read -rs PW && aws cognito-idp admin-set-user-password --user-pool-id <adminPoolId> --username <owner e-mail> --password "$PW" --permanent; unset PW`. Enrol TOTP in an authenticated session (`aws cognito-idp associate-software-token` with the session of a password sign-in, the secret into the authenticator app, then `aws cognito-idp verify-software-token`, then `aws cognito-idp admin-set-user-mfa-preference --software-token-mfa-settings Enabled=true,PreferredMfa=true`). The app also needs the `admin_users` row (role `superadmin`, the user's `cognito_sub`) in the private database, and no tool writes it yet: this is a Needs decision of WPU-Z11. Stop here and ask; never open a database path for it (R2).
   3. Second admin: the superadmin invites a second person on `/admins` (role finance or superadmin), because an FX rate needs four eyes (two different admins).
   4. Leave every product flag off. Buying stays off until the owner decides otherwise (R12).
   5. Budget: confirm each alarm e-mail subscription (Amazon SNS sends a confirmation message), check that the budget e-mail of 40 USD and 50 USD is configured in AWS Budgets, and the next day read the cost in Cost Explorer.

## Rollback

- A production deploy that fails part way: SST leaves the previous resources in place; fix by pull request and push the next tag. To return to the last good version, push a new tag on the last good commit (`git tag -a v0.1.2 <good commit> -m "Rollback"` then `git push origin v0.1.2`); the tag must be on `main`.
- A broken staging: run `remove-staging.yml`, fix, run `deploy-staging.yml` again.
- A wrong secret: run `scripts/golive/stage-secrets.sh <stage> --force` (every value is replaced; the random keys change, so customer sessions and drafts expire) or set the one name with `npx sst secret set <Name> --stage <stage>` by hand, then redeploy.
- A wrong CI role stack: fix the template by pull request and run `scripts/golive/ci-roles.sh` again; never delete the Deny statements of a CI role.

## What to log

In JOURNEY.md: the date of each step, the stack names and statuses of step 3, the names (never the values) of the secrets set in step 6, the tag pushed, the result of the post-deploy check, the NAT address change, and every VERIFY result (the OIDC subject in the first AssumeRoleWithWebIdentity event of CloudTrail, any AccessDenied of a CI role).

## Must not

- Never run these steps from a Claude Code session, and never paste a secret value, an account id or an ARN into a chat, an issue or this page.
- Never deploy production by hand. `infra/lib/stage.ts` refuses the stage production unless `CI=true` and `TC_PRODUCTION_DEPLOY=ci-approved` are set; that guard stops mistakes, not a person who sets the two variables. `scripts/golive/stage-secrets.sh` sets them only for its own `sst secret list` and `sst secret set` calls (a ruling is requested), and refuses any other sst command.
- Never use the management account; `scripts/golive/ci-roles.sh` refuses it.
- Never widen a CI role by removing a Deny statement; widen by pull request after reading the AccessDenied in CloudTrail.
- Never turn a product flag on at go-live.
