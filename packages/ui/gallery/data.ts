// Demo data of the gallery: the only place that holds them (WPU-T4, Task 9). Amounts are bigint
// paisa (R4). Nothing here is real: addresses are in the ranges reserved for documentation, and
// names carry the word demo. Words for people live in messages (U5); only technical values are here.

/** The four amounts of the MoneyText sample: zero, under one taka, a typical balance, a large one. */
export const MONEY_SAMPLES: readonly bigint[] = [0n, 99n, 125050n, 100_000_000n];

export const DEMO_BALANCE_MINOR = 125_050n;

/** A fixed UTC instant, so the sample never changes with the clock. */
export const DEMO_INSTANT = "2026-11-11T04:30:00Z";

export const DEMO_PLAN_PRICES = { nano: 49_900n, small: 99_900n, medium: 199_900n } as const;

/** Technical values of the plan specifications (sizes are always in Latin digits, 16.13). */
export const DEMO_PLAN_SPECS = {
  nano: { cpu: "1 vCPU", ram: "1 GB", disk: "40 GB", transfer: "2 TB" },
  small: { cpu: "2 vCPU", ram: "2 GB", disk: "60 GB", transfer: "3 TB" },
  medium: { cpu: "2 vCPU", ram: "4 GB", disk: "80 GB", transfer: "4 TB" },
} as const;

/** Theme line icons of the four specification lines of a plan card. */
export const DEMO_SPEC_ICONS = {
  cpu: "icon-cpu",
  ram: "icon-ram",
  disk: "icon-drivessd",
  transfer: "icon-speed",
} as const;

/** Logos under /theme/assets/apps/ and their names (product names are not translated). */
export const DEMO_IMAGES = [
  { value: "debian", label: "Debian", src: "/theme/assets/apps/debian.svg" },
  { value: "docker", label: "Docker", src: "/theme/assets/apps/docker.svg" },
  { value: "centos", label: "CentOS", src: "/theme/assets/apps/centos.svg" },
] as const;

/** The price steps of the breakdown: 800.00 plus 120.00 less 50.00 is 870.00 taka (87000 paisa). */
export const DEMO_BREAKDOWN = {
  baseMinor: 80_000n,
  stepOneMinor: 12_000n,
  stepTwoMinor: -5_000n,
  totalMinor: 87_000n,
} as const;

export const DEMO_ROWS = [
  { id: "a", state: "running", priceMinor: 49_900n },
  { id: "b", state: "creating", priceMinor: 99_900n },
  { id: "c", state: "grace", priceMinor: 199_900n },
] as const;

/** The nine states of 16.13 in the order of the kit (the payment row holds three). */
export const DEMO_STATES = [
  "creating",
  "running",
  "stopped",
  "grace",
  "retained",
  "problem",
  "paid",
  "pending",
  "failed",
] as const;

/** Not a secret: a fixed demo string that is shown and copied only here. */
export const DEMO_SECRET = "DEMO-VALUE-NOT-A-SECRET";

/** 203.0.113.0/24 is reserved for documentation (RFC 5737). */
export const DEMO_IP = "203.0.113.10";

export const DEMO_RESOURCE_NAME = "demo-server-1";

/** A request id as the error page prints it. */
export const DEMO_REFERENCE_ID = "REQ-DEMO-0001";

export const DEMO_TIMELINE_AT = "2026-11-11T04:30:00Z";
