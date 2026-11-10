<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md lines 491-519. Change the plan, then run pnpm spec:split. -->

## H. Product brief

| Topic | Decision |
| --- | --- |
| Problem | Developers, agencies and small companies in Bangladesh want AWS but cannot pay AWS easily: it needs an international card in dollars, there is no taka invoice, and a bill arrives after use |
| Product | TiCON Cloud: Amazon Lightsail resources sold prepaid in taka through a Bengali-first panel, paid by EPS, with VAT invoices and local support |
| Promise to the customer | 100% AWS infrastructure, at about the AWS price, in taka, prepaid, with a taka invoice and support in Bengali |
| Customers | Web and software agencies; SaaS companies and startups; e-commerce shops; existing TiCON Cloud customers (for dev and test servers); developers and students |
| Price | AWS list price x FX rate x 1.17 (10% Korea VAT, 5% Bangladesh VAT, 2% processing fee, each on the AWS price). At FX 127 the 5 USD plan is 743 taka for 30 days, about 1.7% above buying from AWS directly with 15% VAT |
| What TiCON adds | Local payment, prepaid control of spending, identity checks, taka invoices, Bengali support, a path to full AWS with TiCON later |
| Not in this product | Postpaid billing, AWS console or API access for customers, mail sending (port 25 stays closed), private networking between customers, hourly billing, resources outside Lightsail |
| Launch scope | Core on launch day; Gate A and Gate B families when they pass their tests (Section 1) |
| Markets after Bangladesh | Africa and other retail markets. A market is a config row: currency, gateway, pricing steps, locales |

Metrics. All come from existing tables, so no tracking script is needed:

| Metric | Definition | Target |
| --- | --- | --- |
| Active paid resources (north star) | Subscriptions in state `active` | 20 on launch day, 50 by day 14, 100 by day 30 |
| Activation funnel | Signed up, phone verified, KYC submitted, KYC verified, first verified top-up, first active resource (counts and step conversion per day) | Measured from beta; targets set after week one |
| Time to first server | From first verified top-up to the first resource in state `active` | Median under 5 minutes |
| KYC review time | From submission to decision | Under 2 working hours in launch week |
| Provisioning success | Operations of kind create that end `succeeded` | 98% or more |
| Money integrity | Wallet balance minus ledger sum, per wallet | Zero differences, every night |
| Cost integrity | AWS cost of pool accounts against expected cost from active subscriptions | Variance under 2%; zero unexplained resources |
| Renewal rate | Subscriptions renewed at their first period end | Measured from day 30 |

The admin dashboard shows the first five every day (16.12, route `/`).

