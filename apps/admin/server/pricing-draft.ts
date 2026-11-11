// The draft of a pricing rule as the editor sends it: plain text fields, no script on the page. The
// editor is a GET form (the preview is computed on the server from the query) and the save form carries
// the same fields as hidden inputs, so one reader serves both. Rates stay decimal text (R4); nothing here
// converts a rate to a number.

export const MAX_DRAFT_STEPS = 8;
export const STEP_FIELDS = ["code", "rate", "base", "bn", "en"] as const;
export type StepField = (typeof STEP_FIELDS)[number];

export interface DraftStep {
  readonly code: string;
  readonly rate: string;
  readonly base: string;
  readonly bn: string;
  readonly en: string;
}

export interface Draft {
  readonly market: string;
  // null: the rule of the whole market.
  readonly family: string | null;
  readonly steps: readonly DraftStep[];
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: string;
  // A candidate FX rate to preview next to the steps, or "".
  readonly fx: string;
}

const MARKET = /^[A-Z]{2}$/;
const FAMILY = /^[a-z][a-z_]{0,39}$/;

export const fieldName = (field: StepField, index: number): string => `${field}${index}`;

export type Getter = (name: string) => string;

const clean = (value: string, max: number): string => value.trim().slice(0, max);

/**
 * The draft from a getter over a query or a form. A row with every field empty is dropped, so the blank
 * row of the editor adds nothing. A market that is not two capital letters falls back to `fallbackMarket`.
 */
export function readDraft(get: Getter, fallbackMarket: string): Draft {
  const market = MARKET.test(get("market").trim()) ? get("market").trim() : fallbackMarket;
  const rawFamily = get("family").trim();
  const family = FAMILY.test(rawFamily) ? rawFamily : null;
  const steps: DraftStep[] = [];
  for (let i = 0; i < MAX_DRAFT_STEPS; i += 1) {
    const step: DraftStep = {
      code: clean(get(fieldName("code", i)), 40),
      rate: clean(get(fieldName("rate", i)), 20),
      base: clean(get(fieldName("base", i)), 10),
      bn: clean(get(fieldName("bn", i)), 80),
      en: clean(get(fieldName("en", i)), 80),
    };
    if (Object.values(step).some((v) => v !== "")) steps.push(step);
  }
  return {
    market,
    family,
    steps,
    from: clean(get("from"), 16),
    fx: clean(get("fx"), 14),
  };
}

/** True when the query asks for a preview: the editor sets `go`. A bare visit shows the rule in force. */
export const wantsPreview = (get: Getter): boolean => get("go") === "1";

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * The instant of a Dhaka wall time (UTC+6 all year, no daylight saving), or `undefined` for "", or
 * `null` when the text is not a valid time.
 */
export function startOf(text: string): Date | undefined | null {
  if (text === "") return undefined;
  if (!LOCAL_TIME.test(text)) return null;
  const at = new Date(`${text}:00+06:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}
