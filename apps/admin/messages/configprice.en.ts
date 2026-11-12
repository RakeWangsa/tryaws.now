import type { configPriceBn } from "./configprice.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const configPriceEn: Same<typeof configPriceBn> = {
  AdminConfigPrices: {
    title: "Prices that AWS does not publish",
    intro:
      "The prices of the load balancer, the snapshot, block storage and the DNS zone do not come from an AWS API. Enter the AWS base price in US dollars here and choose when it starts. A new price applies to new orders only. An order that is already placed and the current period keep their price. Pricing rules and margins are on other pages.",
    back: "Go to pricing and exchange rate",
    market: { label: "Market", submit: "Show" },
    unavailable: {
      title: "Could not load the data",
      body: "The data is not available right now. Try again in a little while.",
    },
    result: {
      ok: "Saved.",
      replayed: "This change was already saved.",
      invalid: "The form is not correct. Check the fields.",
      denied: "You are not allowed to do this.",
      conflict: "Another price already starts at that time. Choose another time.",
      not_found: "There is no exchange rate or pricing rule in force.",
      rate_limited: "Too many attempts. Try again in a few minutes.",
      unavailable: "This cannot be done right now. Try again in a little while.",
    },
    summary: {
      fx: "Current dollar rate",
      noFx: "This market has no rate, so no price can be shown.",
      rounding: "Rounding",
      roundingValue: "Half up (0.5 rounds up), in paisa",
    },
    names: {
      block_storage_gb_month: "Block storage (per GB, per month)",
      snapshot_gb_month: "Snapshot (per GB, per month)",
      load_balancer_month: "Load balancer (per month)",
      dns_zone_month: "DNS zone (per month)",
      static_ip_unattached_hour: "Unattached static IP (per hour)",
    },
    unit: { gb_month: "GB-month", month: "month", hour: "hour" },
    list: {
      title: "Price list",
      intro:
        "The AWS base price in US dollars. The customer price is worked out from the pricing rule, the exchange rate and the margin; it is never stored.",
      caption: "Prices that AWS does not publish",
    },
    columns: {
      name: "Product",
      unit: "Unit",
      usd: "Price in force (USD)",
      customer: "Customer price (one unit)",
      scheduled: "Next change",
      used: "Used by orders",
    },
    state: {
      none: "No price set",
      invalid: "Cannot be read",
      readNow: "Used for charges",
      notReadYet: "Not read by orders yet",
    },
    editor: {
      title: "Change the price: {name}",
      edit: "Change",
      intro:
        "Enter the new price, then look at the preview first. The save button appears only under a good preview. Leave the start empty to start now.",
      notReadYet:
        "Note: this price is stored and can be changed, but no order reads it today. It has to be connected before it affects an order.",
      usd: "AWS price (USD, for one unit)",
      usdHint: "Digits, at most 4 decimals, not zero. For example 0.50 or 18.",
      from: "Start (Dhaka time)",
      fromHint: "Year-month-dayThour:minute, for example 2026-12-01T09:00. At most 90 days ahead.",
      previewSubmit: "Show preview",
    },
    preview: {
      caption: "Preview: {name}",
      priceNow: "Price now",
      priceNew: "New price",
      margin: "Margin",
      commission: "Commission",
      change: "Change",
      onlyNew: "The new price applies to new orders only.",
      invalid: "The preview could not be made. Check: {fields}",
      unavailable: "The preview cannot be made right now. Try again in a little while.",
      saveTitle: "Save",
      save: "Save price",
    },
    reason: {
      label: "Reason",
      hint: "For example: AWS pricing page, with the date. It goes to the audit log.",
    },
    history: {
      title: "History",
      caption: "Price history of {name}",
      auditCaption: "Reasons for the changes",
      empty: "This price has no history.",
      from: "Start",
      state: "State",
      usd: "USD",
      by: "By",
      when: "When",
      reason: "Reason",
      inForce: "In force",
      scheduled: "Starts later",
      past: "Earlier",
    },
  },
};
