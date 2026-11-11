import { describe, expect, it } from "vitest";
import {
  DNS_MAX_TTL,
  DNS_MIN_TTL,
  checkChange,
  validateRecord,
  validateZoneName,
  type ValidRecord,
} from "./index";

const ZONE = "example.com";

function ok(input: { name: string; type: string; ttl?: number; values: string[] }): ValidRecord {
  const r = validateRecord(ZONE, { ttl: 300, ...input });
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.value;
}
function bad(input: { name: string; type: string; ttl?: number; values: unknown }) {
  const r = validateRecord(ZONE, { ttl: 300, ...input } as never);
  if (r.ok) throw new Error(`expected refusal, got ${JSON.stringify(r)}`);
  expect(r.error).toBe("validation");
  return r.fields ?? {};
}

describe("validateZoneName", () => {
  it.each(["example.com", "a.b.example.co.uk", "xn--bcher-kva.example", "my-site.com", "A.COM"])(
    "accepts %s and lower-cases it",
    (name) => {
      const r = validateZoneName(name);
      expect(r).toEqual({ ok: true, value: name.toLowerCase() });
    },
  );
  it("drops one trailing dot", () => {
    expect(validateZoneName("example.com.")).toEqual({ ok: true, value: "example.com" });
  });
  it.each([
    "",
    "com",
    ".",
    "example..com",
    "-a.com",
    "a-.com",
    "a_b.com",
    "*.example.com",
    "exa mple.com",
    "example.com/path",
    "http://example.com",
    "bücher.de",
    "example.123",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
    "example.com..",
    "192.168.0.1",
  ])("refuses %j", (name) => {
    const r = validateZoneName(name);
    expect(r.ok).toBe(false);
  });
  it("refuses a value that is not text", () => {
    expect(validateZoneName(42 as never).ok).toBe(false);
    expect(validateZoneName(undefined as never).ok).toBe(false);
  });
  it("accepts a name of 253 characters and refuses 254", () => {
    const label = "a".repeat(63);
    const long = `${label}.${label}.${label}.${"b".repeat(61)}.com`; // 63*3+3+61+1+3 = 257? adjust below
    const make = (n: number) => {
      const head = [label, label, label, "x".repeat(Math.max(1, n - 63 * 3 - 3 - 4))].join(".");
      return `${head}.com`;
    };
    expect(make(253).length).toBe(253);
    expect(validateZoneName(make(253)).ok).toBe(true);
    expect(validateZoneName(make(254)).ok).toBe(false);
    expect(long.length).toBeGreaterThan(253);
  });
});

describe("record names", () => {
  it.each([
    ["@", "example.com", true],
    ["", "example.com", true],
    ["www", "www.example.com", false],
    ["WWW", "www.example.com", false],
    ["a.b", "a.b.example.com", false],
    ["www.example.com", "www.example.com", false],
    ["www.example.com.", "www.example.com", false],
    ["example.com", "example.com", true],
    ["*", "*.example.com", false],
    ["*.sub", "*.sub.example.com", false],
    ["_dmarc", "_dmarc.example.com", false],
    ["_sip._tcp", "_sip._tcp.example.com", false],
    ["xn--bcher-kva", "xn--bcher-kva.example.com", false],
  ])("name %j becomes %s (apex %s)", (name, fqdn, apex) => {
    const r = ok({ name, type: "TXT", values: ["hello"] });
    expect(r.fqdn).toBe(fqdn);
    expect(r.isApex).toBe(apex);
  });
  it.each([
    "a..b",
    "-a",
    "a-",
    "w w w",
    "a.*",
    "*a",
    "a*.b",
    "exämple",
    "a/b",
    "a:b",
    `${"a".repeat(64)}`,
    "..",
    ".",
    "a.",
    "-",
    "www\n",
    "www\0",
  ])("refuses the record name %j", (name) => {
    const fields = bad({ name, type: "TXT", values: ["x"] });
    expect(fields.name).toBeTypeOf("string");
  });
  it("refuses a name that is not text", () => {
    expect(bad({ name: 5 as never, type: "A", values: ["1.2.3.4"] }).name).toBeTypeOf("string");
  });
  it("does not accept a suffix match that is not a label boundary", () => {
    // "notexample.com" ends with "example.com" but is not inside the zone.
    expect(bad({ name: "notexample.com", type: "A", values: ["1.2.3.4"] }).name).toBe(
      "outside_zone",
    );
  });
  it("refuses an fqdn over 253 characters", () => {
    const label = "a".repeat(60);
    const name = `${label}.${label}.${label}`;
    expect(name.length + ZONE.length + 1).toBeLessThanOrEqual(253);
    expect(validateRecord(ZONE, { name, type: "A", ttl: 300, values: ["1.2.3.4"] }).ok).toBe(true);
    const long = `${label}.${label}.${label}.${label}`;
    expect(long.length + ZONE.length + 1).toBeGreaterThan(253);
    expect(bad({ name: long, type: "A", values: ["1.2.3.4"] }).name).toBe("too_long");
  });
});

describe("type and ttl", () => {
  it.each(["SOA", "PTR", "DS", "a", "ALIAS", "", "TXT ", "__proto__", "constructor"])(
    "refuses the type %j",
    (type) => {
      expect(bad({ name: "x", type, values: ["1.2.3.4"] }).type).toBeTypeOf("string");
    },
  );
  it.each([DNS_MIN_TTL, 300, DNS_MAX_TTL])("accepts ttl %i", (ttl) => {
    expect(ok({ name: "x", type: "A", ttl, values: ["1.2.3.4"] }).ttl).toBe(ttl);
  });
  it.each([0, 59, DNS_MAX_TTL + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "300", null])(
    "refuses ttl %j",
    (ttl) => {
      expect(bad({ name: "x", type: "A", ttl: ttl as never, values: ["1.2.3.4"] }).ttl).toBeTypeOf(
        "string",
      );
    },
  );
  it("refuses values that are not a list, an empty list or a list of non-text", () => {
    expect(bad({ name: "x", type: "A", values: "1.2.3.4" }).values).toBeTypeOf("string");
    expect(bad({ name: "x", type: "A", values: [] }).values).toBeTypeOf("string");
    expect(bad({ name: "x", type: "A", values: [1] })["values.0"]).toBeTypeOf("string");
  });
  it("refuses duplicate values and too many values", () => {
    expect(bad({ name: "x", type: "A", values: ["1.2.3.4", "1.2.3.4"] }).values).toBe("duplicate");
    const many = Array.from({ length: 21 }, (_, i) => `10.0.0.${i + 1}`);
    expect(bad({ name: "x", type: "A", values: many }).values).toBe("too_many");
    expect(ok({ name: "x", type: "A", values: many.slice(0, 20) }).values).toHaveLength(20);
  });
});

describe("A", () => {
  it.each(["1.2.3.4", "0.0.0.0", "255.255.255.255", "10.0.0.1"])("accepts %s", (v) => {
    expect(ok({ name: "x", type: "A", values: [v] }).values).toEqual([v]);
  });
  it.each([
    "256.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4",
    "1.2.3.04",
    "a.b.c.d",
    "1.2.3.4 ",
    " 1.2.3.4",
    "1.2.3.-4",
    "1..3.4",
    "::1",
    "example.com",
    "1.2.3.4/32",
    "1.2.3.4\n",
    "٣.٣.٣.٣",
    "",
  ])("refuses %j", (v) => {
    expect(bad({ name: "x", type: "A", values: [v] })["values.0"]).toBeTypeOf("string");
  });
});

describe("AAAA", () => {
  it.each([
    ["::1", "::1"],
    ["::", "::"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8:0:0:0:0:0:1"],
    ["fe80::1:2:3:4", "fe80::1:2:3:4"],
    ["::ffff:1.2.3.4", "::ffff:1.2.3.4"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"],
  ])("accepts %s", (v, out) => {
    expect(ok({ name: "x", type: "AAAA", values: [v] }).values).toEqual([out]);
  });
  it.each([
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    ":1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:",
    "12345::1",
    "g::1",
    "::1/128",
    "[::1]",
    "1.2.3.4",
    "::1.2.3",
    "1:2:3:4:5:6:7::8",
    ":::",
    "",
    "2001:db8::1 ",
    "fe80::1%eth0",
  ])("refuses %j", (v) => {
    expect(bad({ name: "x", type: "AAAA", values: [v] })["values.0"]).toBeTypeOf("string");
  });
});

describe("CNAME", () => {
  it("accepts one target, lower-cased, without the trailing dot", () => {
    expect(ok({ name: "www", type: "CNAME", values: ["Target.Example.NET."] }).values).toEqual([
      "target.example.net",
    ]);
  });
  it("refuses a CNAME at the apex", () => {
    expect(bad({ name: "@", type: "CNAME", values: ["target.example.net"] }).name).toBe(
      "apex_cname",
    );
    expect(bad({ name: "example.com", type: "CNAME", values: ["t.example.net"] }).name).toBe(
      "apex_cname",
    );
  });
  it("refuses more than one value", () => {
    expect(
      bad({ name: "www", type: "CNAME", values: ["a.example.net", "b.example.net"] }).values,
    ).toBe("single_value");
  });
  it("refuses a CNAME that points at itself", () => {
    expect(bad({ name: "www", type: "CNAME", values: ["www.example.com"] })["values.0"]).toBe(
      "points_at_itself",
    );
  });
  it.each([
    "1.2.3.4",
    "a b",
    "-a.com",
    "a..com",
    "a.com/x",
    "http://a.com",
    "",
    "a_b.com",
    "*.a.com",
  ])("refuses the target %j", (v) => {
    expect(bad({ name: "www", type: "CNAME", values: [v] })["values.0"]).toBeTypeOf("string");
  });
  it("allows a wildcard CNAME name", () => {
    expect(ok({ name: "*", type: "CNAME", values: ["t.example.net"] }).fqdn).toBe("*.example.com");
  });
});

describe("MX", () => {
  it("accepts priority and host", () => {
    expect(ok({ name: "@", type: "MX", values: ["10 mail.example.net."] }).values).toEqual([
      "10 mail.example.net",
    ]);
    expect(ok({ name: "@", type: "MX", values: ["0  Mail.example.net"] }).values).toEqual([
      "0 mail.example.net",
    ]);
  });
  it("accepts the null MX", () => {
    expect(ok({ name: "@", type: "MX", values: ["0 ."] }).values).toEqual(["0 ."]);
  });
  it.each([
    "mail.example.net",
    "10",
    "-1 mail.example.net",
    "65536 mail.example.net",
    "1.5 mail.example.net",
    "x mail.example.net",
    "10 1.2.3.4",
    "10 mail.example.net extra",
    "10 -bad.example.net",
    "10 mail..example.net",
    "10 ",
    "",
  ])("refuses %j", (v) => {
    expect(bad({ name: "@", type: "MX", values: [v] })["values.0"]).toBeTypeOf("string");
  });
  it("accepts priority 65535", () => {
    expect(ok({ name: "@", type: "MX", values: ["65535 m.example.net"] }).values).toHaveLength(1);
  });
});

describe("TXT", () => {
  it("quotes the text and escapes quote and backslash", () => {
    expect(
      ok({ name: "@", type: "TXT", values: ["v=spf1 include:_spf.example.net ~all"] }).values,
    ).toEqual(['"v=spf1 include:_spf.example.net ~all"']);
    expect(ok({ name: "x", type: "TXT", values: ['a "b" \\c'] }).values).toEqual([
      '"a \\"b\\" \\\\c"',
    ]);
  });
  it("splits a long text into chunks of at most 255 characters", () => {
    const text = "a".repeat(600);
    const [value] = ok({ name: "x", type: "TXT", values: [text] }).values;
    const chunks = value!.match(/"[^"]*"/g)!;
    expect(chunks.map((c) => c.length - 2)).toEqual([255, 255, 90]);
    expect(value).toBe(chunks.join(" "));
  });
  it("does not cut an escape sequence between two chunks", () => {
    const text = `${"a".repeat(254)}"b`;
    const [value] = ok({ name: "x", type: "TXT", values: [text] }).values;
    for (const chunk of value!.match(/"(?:[^"\\]|\\.)*"/g)!) {
      // the content of a chunk, as the DNS sees it, is at most 255 characters
      const raw = chunk.slice(1, -1).replace(/\\(.)/g, "$1");
      expect(raw.length).toBeLessThanOrEqual(255);
    }
    expect(value).toBe(`"${"a".repeat(254)}\\"" "b"`);
  });
  it("accepts 4000 characters and refuses 4001", () => {
    expect(ok({ name: "x", type: "TXT", values: ["a".repeat(4000)] }).values).toHaveLength(1);
    expect(bad({ name: "x", type: "TXT", values: ["a".repeat(4001)] })["values.0"]).toBe(
      "too_long",
    );
  });
  it("refuses a text the customer already quoted", () => {
    expect(bad({ name: "x", type: "TXT", values: ['"v=spf1 ~all"'] })["values.0"]).toBe(
      "already_quoted",
    );
  });
  it.each(["", "line\nbreak", "tab\there", "nul\0", "café", "\u0007bell", "emoji \u{1F600}", "\r"])(
    "refuses the text %j",
    (v) => {
      expect(bad({ name: "x", type: "TXT", values: [v] })["values.0"]).toBeTypeOf("string");
    },
  );
});

describe("NS", () => {
  it("accepts delegation below the apex", () => {
    expect(
      ok({ name: "sub", type: "NS", values: ["ns1.other.net.", "NS2.other.net"] }).values,
    ).toEqual(["ns1.other.net", "ns2.other.net"]);
  });
  it("does not let a customer write the apex NS", () => {
    expect(bad({ name: "@", type: "NS", values: ["ns1.other.net"] }).name).toBe("apex_read_only");
  });
  it.each(["1.2.3.4", "a b", "-x.net", ""])("refuses the host %j", (v) => {
    expect(bad({ name: "sub", type: "NS", values: [v] })["values.0"]).toBeTypeOf("string");
  });
});

describe("SRV", () => {
  it("accepts priority weight port target", () => {
    const r = ok({ name: "_sip._tcp", type: "SRV", values: ["10 60 5060 Sip.example.net."] });
    expect(r.values).toEqual(["10 60 5060 sip.example.net"]);
  });
  it("accepts the unavailable service target", () => {
    expect(ok({ name: "_sip._tcp", type: "SRV", values: ["0 0 0 ."] }).values).toEqual(["0 0 0 ."]);
  });
  it.each([
    "10 60 5060",
    "10 60 5060 a.b extra",
    "-1 0 80 a.b",
    "0 65536 80 a.b",
    "0 0 65536 a.b",
    "x 0 80 a.b",
    "0 0 80 1.2.3.4",
    "0 0 80 -a.b",
    "0 0 80 ",
    "",
  ])("refuses %j", (v) => {
    expect(bad({ name: "_sip._tcp", type: "SRV", values: [v] })["values.0"]).toBeTypeOf("string");
  });
  it.each(["sip", "_sip", "sip._tcp", "_sip.tcp", "@", "_sip._tcp._x._y"])(
    "refuses the name %j (needs _service._proto)",
    (name) => {
      const fields = bad({ name, type: "SRV", values: ["0 0 80 a.example.net"] });
      expect(fields.name).toBeTypeOf("string");
    },
  );
  it("accepts a name with the two underscore labels and a host after them", () => {
    expect(
      ok({ name: "_sip._tls.host", type: "SRV", values: ["0 0 443 a.example.net"] }).fqdn,
    ).toBe("_sip._tls.host.example.com");
    expect(ok({ name: "_sip._udp", type: "SRV", values: ["0 0 443 a.example.net"] }).fqdn).toBe(
      "_sip._udp.example.com",
    );
  });
});

describe("CAA", () => {
  it("accepts flags tag value and quotes the value", () => {
    expect(ok({ name: "@", type: "CAA", values: ["0 issue letsencrypt.org"] }).values).toEqual([
      '0 issue "letsencrypt.org"',
    ]);
    expect(ok({ name: "@", type: "CAA", values: ['0 issue "letsencrypt.org"'] }).values).toEqual([
      '0 issue "letsencrypt.org"',
    ]);
    expect(ok({ name: "@", type: "CAA", values: ["0 issuewild ;"] }).values).toEqual([
      '0 issuewild ";"',
    ]);
    expect(
      ok({ name: "@", type: "CAA", values: ["128 issue ca.example.net; account=1"] }).values,
    ).toEqual(['128 issue "ca.example.net; account=1"']);
    expect(
      ok({ name: "@", type: "CAA", values: ["0 iodef mailto:sec@example.net"] }).values,
    ).toEqual(['0 iodef "mailto:sec@example.net"']);
    expect(
      ok({ name: "@", type: "CAA", values: ["0 iodef https://example.net/r"] }).values,
    ).toHaveLength(1);
  });
  it.each([
    "0 issue",
    "1 issue ca.example.net",
    "256 issue ca.example.net",
    "0 ISSUE ca.example.net",
    "0 issue2 ca.example.net",
    "0 bad_tag ca.example.net",
    "0 foo ca.example.net",
    "0 issue -bad.net",
    "0 issue a b",
    "0 iodef ftp://example.net",
    "0 iodef example.net",
    "0 issue " + "a".repeat(300),
    "0 issue a\\b",
    "x issue ca.example.net",
    "",
  ])("refuses %j", (v) => {
    expect(bad({ name: "@", type: "CAA", values: [v] })["values.0"]).toBeTypeOf("string");
  });
});

describe("customer text never reaches the output as anything but the validated name", () => {
  it("returns only the fields of the contract, as plain values", () => {
    const r = ok({ name: "www", type: "A", values: ["1.2.3.4"] });
    expect(Object.keys(r).sort()).toEqual(["fqdn", "isApex", "ttl", "type", "values"]);
    expect(r.type).toBe("A");
  });
  it("does not echo the refused text in the refusal", () => {
    const fields = bad({ name: "<script>alert(1)</script>", type: "A", values: ["1.2.3.4"] });
    expect(JSON.stringify(fields)).not.toContain("script");
  });
  it("normalises the type from exact upper-case only", () => {
    expect(bad({ name: "x", type: "txt", values: ["a"] }).type).toBeTypeOf("string");
  });
});

describe("checkChange", () => {
  const set = (name: string, type: string): { fqdn: string; type: string } => ({
    fqdn: name,
    type,
  });
  const existing = [
    set("example.com", "NS"),
    set("example.com", "SOA"),
    set("example.com", "A"),
    set("www.example.com", "CNAME"),
    set("mail.example.com", "A"),
    set("mail.example.com", "TXT"),
  ];
  const rec = (name: string, type: string, values: string[]) => ok({ name, type, values });

  it("allows a new record set", () => {
    const r = checkChange(ZONE, existing, {
      action: "create",
      record: rec("api", "A", ["1.2.3.4"]),
    });
    expect(r).toEqual({ ok: true, value: undefined });
  });
  it("create of an existing name and type is a conflict; upsert replaces it", () => {
    const create = checkChange(ZONE, existing, {
      action: "create",
      record: rec("mail", "A", ["1.2.3.4"]),
    });
    expect(create).toMatchObject({ ok: false, error: "conflict" });
    const upsert = checkChange(ZONE, existing, {
      action: "upsert",
      record: rec("mail", "A", ["1.2.3.4"]),
    });
    expect(upsert.ok).toBe(true);
  });
  it("refuses a CNAME next to other data and other data next to a CNAME", () => {
    expect(
      checkChange(ZONE, existing, {
        action: "create",
        record: rec("mail", "CNAME", ["x.example.net"]),
      }),
    ).toMatchObject({ ok: false, error: "conflict", fields: { name: "cname_conflict" } });
    expect(
      checkChange(ZONE, existing, { action: "create", record: rec("www", "A", ["1.2.3.4"]) }),
    ).toMatchObject({ ok: false, error: "conflict", fields: { name: "cname_conflict" } });
  });
  it("lets a CNAME set be replaced by an upsert of itself", () => {
    expect(
      checkChange(ZONE, existing, {
        action: "upsert",
        record: rec("www", "CNAME", ["y.example.net"]),
      }).ok,
    ).toBe(true);
  });
  it("refuses any change to the apex NS and SOA, also a delete", () => {
    for (const type of ["NS", "SOA"]) {
      for (const action of ["create", "upsert", "delete"] as const) {
        const record = {
          fqdn: ZONE,
          type,
          ttl: 300,
          values: ["x"],
          isApex: true,
        } as unknown as ValidRecord;
        expect(checkChange(ZONE, existing, { action, record })).toMatchObject({
          ok: false,
          error: "forbidden",
          fields: { type: "apex_read_only" },
        });
      }
    }
  });
  it("refuses a SOA record at any name", () => {
    const record = {
      fqdn: "x.example.com",
      type: "SOA",
      ttl: 300,
      values: ["x"],
      isApex: false,
    } as unknown as ValidRecord;
    expect(checkChange(ZONE, existing, { action: "create", record })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });
  it("allows a delete of an existing set and answers not_found for a missing one", () => {
    expect(
      checkChange(ZONE, existing, { action: "delete", record: rec("mail", "TXT", ["x"]) }).ok,
    ).toBe(true);
    expect(
      checkChange(ZONE, existing, { action: "delete", record: rec("nothing", "TXT", ["x"]) }),
    ).toMatchObject({ ok: false, error: "not_found" });
  });
  it("refuses a record outside the zone", () => {
    const record = {
      fqdn: "x.other.org",
      type: "A",
      ttl: 300,
      values: ["1.2.3.4"],
      isApex: false,
    } as ValidRecord;
    expect(checkChange(ZONE, existing, { action: "create", record })).toMatchObject({
      ok: false,
      error: "validation",
    });
  });
  it("limits the number of record sets of a zone, apex NS and SOA not counted", () => {
    const full = [
      set("example.com", "NS"),
      set("example.com", "SOA"),
      ...Array.from({ length: 5 }, (_, i) => set(`h${i}.example.com`, "A")),
    ];
    const next = { action: "create" as const, record: rec("new", "A", ["1.2.3.4"]) };
    expect(checkChange(ZONE, full, next, { maxRecordSets: 5 })).toMatchObject({
      ok: false,
      error: "limit_reached",
    });
    expect(checkChange(ZONE, full, next, { maxRecordSets: 6 }).ok).toBe(true);
    // an upsert of an existing set does not add one
    expect(
      checkChange(
        ZONE,
        full,
        { action: "upsert", record: rec("h1", "A", ["1.2.3.4"]) },
        { maxRecordSets: 5 },
      ).ok,
    ).toBe(true);
  });
  it("the default limit is 100 record sets", () => {
    const sets = Array.from({ length: 100 }, (_, i) => set(`h${i}.example.com`, "A"));
    const next = { action: "create" as const, record: rec("new", "A", ["1.2.3.4"]) };
    expect(checkChange(ZONE, sets, next)).toMatchObject({ ok: false, error: "limit_reached" });
    expect(checkChange(ZONE, sets.slice(1), next).ok).toBe(true);
  });
  it("compares names without regard to case", () => {
    const upper = [set("MAIL.Example.com", "A")];
    expect(
      checkChange(ZONE, upper, { action: "create", record: rec("mail", "A", ["1.2.3.4"]) }),
    ).toMatchObject({ ok: false, error: "conflict" });
  });
});
