<!-- GENERATED, do not edit. Source: TICON_CLOUD_MEGA_PLAN.md, section "8. Pricing engine". Change the plan, then run pnpm spec:split. -->

## 8. Pricing engine

Inputs: `aws_price_usd`, the market's current FX rate, and the market's ordered steps. Output: base and one amount per step, all in minor units.

```
base_minor = round_half_up(aws_price_usd * fx_rate * 100)
running    = base_minor
for step in steps:                     # in order
    basis        = base_minor if step.base == "aws" else running
    step.amount  = round_half_up(basis * step.rate)
    running     += step.amount
total_minor = running
```

Launch configuration for market `BD`. The block shows the Bengali label of each step. A stored step has `label` with `bn` and `en`, as `PricingStep` in Section F requires; the English labels are Korea VAT, Bangladesh VAT, Processing fee and Service charge. Each step code posts to one ledger account of 9.1: `korea_vat` to `vat_korea_payable`, `bd_vat` to `vat_bd_payable`, `processing_fee` to `processing_fee_income`, `markup` to `markup_income`. A rule with a step code that has no account is not saved:

```json
[
  {"code": "korea_vat",      "label_bn": "কোরিয়ার VAT",     "rate": "0.10", "base": "aws"},
  {"code": "bd_vat",         "label_bn": "বাংলাদেশের VAT",   "rate": "0.05", "base": "aws"},
  {"code": "processing_fee", "label_bn": "প্রসেসিং ফি",       "rate": "0.02", "base": "aws"},
  {"code": "markup",         "label_bn": "সার্ভিস চার্জ",      "rate": "0",    "base": "aws"}
]
```

Rules:

- A 30-day term is charged the full AWS monthly price of the bundle.
- An order stores the FX rate, the rule version and every step amount. Changing a rate later never changes an existing order or the current period of a subscription. Renewals use the rate and rule in force at renewal time.
- The admin editor shows a preview of five sample products before a new rate or rule is saved, and saves a new row with an effective time.
- Switching `bd_vat.base` to `"subtotal"` (and moving it last) gives the alternative where 5% VAT is charged on the full value. Both must work. Switching the base without moving the step gives a third result that matches neither (5 USD at FX 127: bd_vat 3493, total 74613), so `savePricingRule` refuses a rule in which a step with base `subtotal` is not the last step.

Test vectors (FX 127, launch configuration, all amounts in paisa):

| aws_usd | base | korea_vat | bd_vat | processing_fee | total |
| --- | --- | --- | --- | --- | --- |
| 5 | 63500 | 6350 | 3175 | 1270 | 74295 |
| 7 | 88900 | 8890 | 4445 | 1778 | 104013 |
| 12 | 152400 | 15240 | 7620 | 3048 | 178308 |
| 24 | 304800 | 30480 | 15240 | 6096 | 356616 |
| 44 | 558800 | 55880 | 27940 | 11176 | 653796 |
| 84 | 1066800 | 106680 | 53340 | 21336 | 1248156 |
| 9.50 | 120650 | 12065 | 6033 | 2413 | 141161 |
| 15 | 190500 | 19050 | 9525 | 3810 | 222885 |
| 10 | 127000 | 12700 | 6350 | 2540 | 148590 |
| 18 | 228600 | 22860 | 11430 | 4572 | 267462 |
| 1 | 12700 | 1270 | 635 | 254 | 14859 |
| 2.50 | 31750 | 3175 | 1588 | 635 | 37148 |
| 0.50 | 6350 | 635 | 318 | 127 | 7430 |
| 3.50 | 44450 | 4445 | 2223 | 889 | 52007 |

Extra vectors: FX 124.77 and aws_usd 5 gives base 62385, steps 6239, 3119, 1248, total 72991. With the alternative configuration (bd_vat last on subtotal) and FX 127, aws_usd 5 gives bd_vat 3556 and total 74676. Negative vector: `bd_vat` switched to `subtotal` but left in second place gives bd_vat 3493 and total 74613; a rule in that shape must be refused.

Catalog sync sources: `GetBundles`, `GetBlueprints`, `GetRelationalDatabaseBundles`, `GetRelationalDatabaseBlueprints`, `GetContainerServicePowers`, `GetBucketBundles` per launch Region (transfer allowances differ by Region), `GetDistributionBundles` once in `us-east-1` (distribution APIs answer only there), Route 53 Domains `ListPrices` for TLDs. Prices without an API (load balancer, block storage per GB, snapshot per GB, hosted zone) are admin-editable config rows seeded from the AWS pricing pages.

Instance bundles: `GetBundles` returns bundles with a public IPv4 address (`publicIpv4AddressCount` 1, from 5 USD) and IPv6-only bundles (0, from 3.50 USD). At launch `catalog-sync` marks active only the bundles with a public IPv4 address and stores IPv6-only bundles inactive, because the Linux adapter always attaches a static IP and AWS does not allow a static IP on an IPv6-only instance.

