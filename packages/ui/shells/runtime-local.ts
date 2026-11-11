// Local stand-in for `Locale` and `Messages` of `../runtime/index.ts` (shells Task 2). The controller
// replaces this file with imports from `../runtime/index.ts` when the two tasks are merged.
export type Locale = "bn" | "en";
export type Messages = { readonly [key: string]: string | Messages };
