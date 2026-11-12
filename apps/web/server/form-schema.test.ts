import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formDigits, formObject, formText, readForm } from "./form-schema.ts";

const schema = formObject({ name: formText, size: formDigits(5) });

describe("form-schema (R9: validate with zod)", () => {
  it("trims text and turns plain digits into a number", () => {
    expect(readForm(schema, { name: "  a  ", size: " 12 " })).toEqual({ name: "a", size: 12 });
  });

  it("keeps a value that is not text as it is, for the domain parser to refuse", () => {
    expect(readForm(schema, { name: 5, size: "1" })).toMatchObject({ name: 5 });
    expect(readForm(schema, {})).toEqual({ name: undefined, size: Number.NaN });
  });

  it("accepts only plain ASCII digits within the length: everything else is NaN", () => {
    for (const bad of ["", "1e2", "12.5", "-1", "+1", "0x10", "১২", "123456", 12, null]) {
      expect(readForm(schema, { name: "x", size: bad }).size).toBeNaN();
    }
    expect(readForm(schema, { name: "x", size: "00012" }).size).toBe(12);
  });

  it("reads nothing but the fields of the schema (R11: no other field gets through)", () => {
    const out = readForm(schema, { name: "n", size: "1", customerId: "x", awsName: "tc-y" });
    expect(Object.keys(out).sort()).toEqual(["name", "size"]);
  });

  it("treats a body that is no plain object as empty", () => {
    for (const raw of [null, undefined, "x", 3, [1]]) {
      expect(readForm(schema, raw)).toEqual({ name: undefined, size: Number.NaN });
    }
  });

  it("is a zod schema: it composes with other zod types", () => {
    expect(formText).toBeInstanceOf(z.ZodType);
  });
});
