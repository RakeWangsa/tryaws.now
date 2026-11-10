<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 609-624. Change the plan, then run pnpm spec:split. -->

## N. Risks

| Risk | Effect | Answer |
| --- | --- | --- |
| Quota or Partner approval comes late | No room on launch day | Applied on day 0; start with 40 servers across two Regions and two accounts (20 if the static IP quota does not rise); waitlist for the rest |
| EPS integration fault | No online top-up | For the first days accept bank or wallet deposits and credit through the admin adjustment with approval |
| Billing or lifecycle error | Money lost or customer data deleted | Lifecycle tested on a minute clock; admin approval before deletion; daily reconciliation |
| Whole catalog in one week | Half-finished products reach customers | Feature flag per family; gates on day 6 |
| Customer abuse | AWS notice, action against the account | Identity checks; limits for new customers; separate pool; port 25 closed |
| Customers share a private network inside one account | One customer's server can reach another's private address | OS firewall at first boot; generated database passwords; isolation test; dedicated account for sensitive customers |
| AWS naming rules broken | AWS objects; pages or ads must change | Fixed statements and rules in 16.13; wording confirmed with the AWS Partner manager before launch |
| Bengali text in invoice PDFs renders wrongly | Unreadable invoices | Headless Chromium renderer; VERIFY on day 2; fallback is an English PDF with the Bengali invoice on screen |
| Tracks collide or drift from the plan | Rework, merge conflicts | Contracts of Section F; one task per pull request; fresh-context review; daily gate |
| Review bottleneck on the lead | Merges wait | Reviewer subagents first; CODEOWNERS only on money and security paths; second reviewer named on day 1 |
| Domain registration | No refunds; registrant details needed | Gate B; double confirmation; contact in the customer's name |

