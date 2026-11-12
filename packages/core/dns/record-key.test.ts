import { describe, expect, it } from "vitest";
import { editableValue, validateRecord, validateRecordKey } from "./records";

// WPU-G4: the pieces the record editor needs beyond validateRecord. Pure.

describe("validateRecordKey (the name and type of a record to delete)", () => {
  it("accepts a name inside the zone in the three forms, and a type of the list", () => {
    for (const name of ["www", "www.example.com", "www.example.com."]) {
      expect(validateRecordKey("example.com", name, "A")).toEqual({
        ok: true,
        value: { fqdn: "www.example.com", type: "A", isApex: false },
      });
    }
    expect(validateRecordKey("example.com", "@", "MX")).toEqual({
      ok: true,
      value: { fqdn: "example.com", type: "MX", isApex: true },
    });
  });

  it("refuses the apex NS, SOA, a type outside the list and a name outside the zone", () => {
    expect(validateRecordKey("example.com", "@", "NS")).toMatchObject({
      ok: false,
      error: "validation",
      fields: { name: "apex_read_only" },
    });
    expect(validateRecordKey("example.com", "@", "SOA")).toMatchObject({
      ok: false,
      fields: { type: "unsupported_type" },
    });
    expect(validateRecordKey("example.com", "www", "PTR")).toMatchObject({
      ok: false,
      fields: { type: "unsupported_type" },
    });
    expect(validateRecordKey("example.com", "www.other.com", "A")).toMatchObject({
      ok: false,
      fields: { name: "outside_zone" },
    });
    expect(validateRecordKey("example.com", "bad name!", "A")).toMatchObject({
      ok: false,
      fields: { name: "invalid_name" },
    });
    expect(validateRecordKey("example.com", 5, "A")).toMatchObject({ ok: false });
  });

  it("never repeats the input in its answer (R14)", () => {
    expect(
      JSON.stringify(validateRecordKey("example.com", "secret-token-xyz!", "A")),
    ).not.toContain("secret-token-xyz");
  });
});

describe("editableValue (the wire form back to what the customer types)", () => {
  it("joins the chunks of a TXT value and removes the escapes", () => {
    expect(editableValue("TXT", '"v=spf1 include:_spf.example.com ~all"')).toBe(
      "v=spf1 include:_spf.example.com ~all",
    );
    expect(editableValue("TXT", '"abc" "def"')).toBe("abcdef");
    expect(editableValue("TXT", '"say \\"hi\\" \\\\ ok"')).toBe('say "hi" \\ ok');
  });

  it("leaves the other types as they are", () => {
    expect(editableValue("A", "203.0.113.10")).toBe("203.0.113.10");
    expect(editableValue("MX", "10 mail.example.com")).toBe("10 mail.example.com");
    expect(editableValue("CAA", '0 issue "letsencrypt.org"')).toBe('0 issue "letsencrypt.org"');
  });

  it("round-trips through validateRecord for TXT, including a value of more than 255 characters", () => {
    const long = "a".repeat(300) + '"q"' + "\\";
    const first = validateRecord("example.com", {
      name: "t",
      type: "TXT",
      ttl: 300,
      values: [long],
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      const back = editableValue("TXT", first.value.values[0] as string);
      expect(back).toBe(long);
    }
  });

  it("returns an unquoted or malformed TXT value unchanged instead of throwing", () => {
    expect(editableValue("TXT", "plain")).toBe("plain");
    expect(editableValue("TXT", '"unterminated')).toBe('"unterminated');
  });
});
