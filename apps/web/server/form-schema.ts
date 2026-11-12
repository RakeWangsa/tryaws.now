import { z } from "zod";

// The shared zod pattern of the Server Actions (R9: authenticate, authorize, validate with zod,
// rate limit, execute, audit). A form arrives as loose text. This layer fixes the SHAPE (which
// fields are read, trimmed text, digit-only numbers) and nothing else; the rules of the domain
// (ranges, lists, price) stay in packages/core, so there is one source for each rule. A value
// that has the wrong type is passed on unchanged and refused by the core parser, so no code is
// invented here (the fixed public error codes of the action stay as they are).

/** Text is trimmed; any other value stays as it is for the domain parser to refuse. */
export const formText = z.unknown().transform((v) => (typeof v === "string" ? v.trim() : v));

/**
 * Plain ASCII digits only, at most `maxDigits` of them, as a number. Anything else (a sign, a
 * decimal point, an exponent, a non-ASCII digit, a value that is not text) is NaN, which the
 * domain parser refuses. Surrounding spaces are trimmed first.
 */
export function formDigits(maxDigits: number) {
  const digits = new RegExp(`^[0-9]{1,${maxDigits}}$`);
  return z
    .unknown()
    .transform((v) =>
      typeof v === "string" && digits.test(v.trim()) ? Number(v.trim()) : Number.NaN,
    );
}

/**
 * An object schema for a form. A body that is no plain object reads as empty, and a field that is
 * not in the shape is dropped (R11: customer text never becomes a field the schema did not name).
 */
export function formObject<S extends z.ZodRawShape>(shape: S) {
  const keys = Object.keys(shape);
  return z.preprocess((raw) => {
    const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
    // Every named key is present (a missing one reads as undefined); no other key is carried on.
    return Object.fromEntries(keys.map((k) => [k, (body as Record<string, unknown>)[k]]));
  }, z.object(shape));
}

/**
 * Reads `raw` with a form schema. The shape layer cannot fail (every field accepts unknown), so
 * this returns the output; a schema that can fail throws, which the action turns into a refusal.
 */
export function readForm<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  return schema.parse(raw);
}
