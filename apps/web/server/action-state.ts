// The state a form keeps between two submissions. Plain data: it crosses from a Server Action to a
// Client Component, so it holds text only (money is decimal text, never a number, R4).

export interface FormState {
  /** A public error key; the screen turns it into text in the customer's language. */
  readonly error?: string;
  readonly fields?: Readonly<Record<string, string>>;
  /** A success key such as "added", "replayed" or "removed". */
  readonly done?: string;
  /** After price_changed: the new draft the review page continues with. */
  readonly draft?: {
    token: string;
    totalMinor: string;
    expiresAt: string;
  };
}

export const INITIAL_FORM_STATE: FormState = Object.freeze({});

/** Picks the named string fields of a form; anything else the browser sent is dropped. */
export function pick(form: FormData, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === "string") out[name] = value.slice(0, 8192);
  }
  return out;
}
