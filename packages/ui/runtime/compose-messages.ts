// Merges message modules by top-level namespace. A namespace defined twice is a mistake that would
// silently hide text, so it throws (R16).

export type Messages = { readonly [key: string]: string | Messages };

export function composeMessages(...parts: readonly Messages[]): Messages {
  const merged = new Map<string, string | Messages>();
  for (const part of parts) {
    for (const [namespace, value] of Object.entries(part)) {
      if (merged.has(namespace)) {
        throw new Error(`message namespace "${namespace}" is defined twice`);
      }
      merged.set(namespace, value);
    }
  }
  return Object.fromEntries(merged);
}
