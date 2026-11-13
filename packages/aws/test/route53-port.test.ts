import { describe, expect, it } from "vitest";
import { AwsError } from "../errors";
import { createRoute53Port, type Route53Like } from "../adapters/route53-client";
import { expectNoLeak } from "./fake-aws";

// WPU-D4: the Route 53 client behind Route53Port, against a fake client. No AWS call is made.

type Input = Record<string, unknown>;
function fake(handlers: Record<string, (input: Input) => unknown>) {
  const calls: { op: string; input: Input }[] = [];
  const client: Route53Like = {
    send: async (command) => {
      const sent = command as unknown as { constructor: { name: string }; input: Input };
      const op = sent.constructor.name.replace(/Command$/, "");
      const input = sent.input;
      calls.push({ op, input });
      const handler = handlers[op];
      if (handler === undefined) throw new Error(`unexpected ${op}`);
      return handler(input) as never;
    },
  };
  return { calls, port: createRoute53Port(client) };
}

const raw = (name: string) =>
  Object.assign(new Error("raw: arn:aws:iam::123456789012:role/TcDnsProvisioner not authorized"), {
    name,
  });

const NS = [
  "ns-1.awsdns-01.org",
  "ns-2.awsdns-02.com",
  "ns-3.awsdns-03.net",
  "ns-4.awsdns-04.co.uk",
];
const REF = "0193f7c2-5b8a-7c3e-9a1b-1234567890ab";
const COMMENT = "tc-dnszone-0123456789abcdef";
const hostedZone = (id = "Z0TESTZONE1", name = "shop.example.") => ({
  HostedZone: { Id: `/hostedzone/${id}`, Name: name, CallerReference: REF },
  DelegationSet: { NameServers: NS },
});

describe("createHostedZone", () => {
  it("creates a public zone with a generated reference and comment, and returns the id, name servers and change", async () => {
    const { port, calls } = fake({
      CreateHostedZone: () => ({
        ...hostedZone(),
        ChangeInfo: { Id: "/change/C0CHANGE1", Status: "PENDING" },
      }),
    });
    const out = await port.createHostedZone({
      name: "shop.example",
      callerReference: REF,
      comment: COMMENT,
    });
    // WPU-Z19: the change of the create, which GetChange follows until INSYNC.
    expect(out).toEqual({
      created: true,
      zone: { id: "Z0TESTZONE1", name: "shop.example.", nameServers: NS },
      changeId: "C0CHANGE1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      Name: "shop.example",
      CallerReference: REF,
      HostedZoneConfig: { Comment: COMMENT, PrivateZone: false },
    });
  });

  it("a repeat with the same reference finds the zone it made (created: false)", async () => {
    const { port, calls } = fake({
      CreateHostedZone: () => {
        throw raw("HostedZoneAlreadyExists");
      },
      ListHostedZonesByName: () => ({
        HostedZones: [
          {
            Id: "/hostedzone/Z0OTHER",
            Name: "shop.example.",
            Config: { Comment: "tc-dnszone-ffffffffffffffff" },
          },
          { Id: "/hostedzone/Z0TESTZONE1", Name: "shop.example.", Config: { Comment: COMMENT } },
        ],
        IsTruncated: false,
      }),
      GetHostedZone: (input) => hostedZone(String(input.Id)),
    });
    const out = await port.createHostedZone({
      name: "shop.example",
      callerReference: REF,
      comment: COMMENT,
    });
    expect(out.created).toBe(false);
    // The change of the first call is not known on a repeat.
    expect(out.changeId).toBeNull();
    expect(out.zone.id).toBe("Z0TESTZONE1");
    expect(out.zone.nameServers).toEqual(NS);
    expect(calls.map((c) => c.op)).toEqual([
      "CreateHostedZone",
      "ListHostedZonesByName",
      "GetHostedZone",
    ]);
  });

  it("fails closed with a conflict when the reference is used but no zone of ours can be found", async () => {
    const { port } = fake({
      CreateHostedZone: () => {
        throw raw("HostedZoneAlreadyExists");
      },
      ListHostedZonesByName: () => ({ HostedZones: [], IsTruncated: false }),
    });
    const error = await port
      .createHostedZone({ name: "shop.example", callerReference: REF, comment: COMMENT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({ code: "conflict", retryable: false });
    expectNoLeak(error);
  });

  it("refuses a name, a reference or a comment that the platform did not generate, with no call", async () => {
    const { port, calls } = fake({});
    for (const input of [
      { name: "evil.example\n", callerReference: REF, comment: COMMENT },
      { name: "a b.example", callerReference: REF, comment: COMMENT },
      { name: "shop.example", callerReference: "x y", comment: COMMENT },
      { name: "shop.example", callerReference: REF, comment: "customer text <b>" },
      { name: "shop.example", callerReference: "", comment: COMMENT },
    ]) {
      await expect(port.createHostedZone(input)).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("maps a refusal of the name and the zone quota, and keeps no AWS text", async () => {
    for (const [name, code] of [
      ["InvalidDomainName", "validation"],
      ["TooManyHostedZones", "capacity_full"],
      ["ConflictingDomainExists", "conflict"],
    ] as const) {
      const { port } = fake({
        CreateHostedZone: () => {
          throw raw(name);
        },
      });
      const error = await port
        .createHostedZone({ name: "shop.example", callerReference: REF, comment: COMMENT })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expectNoLeak(error);
    }
  });

  it("refuses an answer without an id or without name servers", async () => {
    for (const answer of [
      {},
      { HostedZone: { Id: "/hostedzone/Z1", Name: "x." } },
      hostedZone("bad id"),
    ]) {
      const { port } = fake({ CreateHostedZone: () => answer });
      await expect(
        port.createHostedZone({ name: "shop.example", callerReference: REF, comment: COMMENT }),
      ).rejects.toBeInstanceOf(AwsError);
    }
  });
});

describe("getHostedZone", () => {
  it("returns the zone with the id without its prefix", async () => {
    const { port, calls } = fake({ GetHostedZone: () => hostedZone() });
    expect(await port.getHostedZone("Z0TESTZONE1")).toEqual({
      id: "Z0TESTZONE1",
      name: "shop.example.",
      nameServers: NS,
    });
    expect(calls[0]?.input).toEqual({ Id: "Z0TESTZONE1" });
  });
  it("returns null for a zone that does not exist", async () => {
    const { port } = fake({
      GetHostedZone: () => {
        throw raw("NoSuchHostedZone");
      },
    });
    expect(await port.getHostedZone("Z0GONE")).toBeNull();
  });
  it("refuses an id that is not a plain hosted zone id, with no call", async () => {
    const { port, calls } = fake({});
    for (const id of ["", "z lower", "/hostedzone/Z1", "Z1;drop", "A".repeat(33)]) {
      await expect(port.getHostedZone(id)).rejects.toMatchObject({ code: "validation" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("listRecordSets", () => {
  it("follows the pagination and returns every set", async () => {
    let page = 0;
    const { port, calls } = fake({
      ListResourceRecordSets: (input) => {
        page += 1;
        if (page === 1) {
          return {
            ResourceRecordSets: [
              {
                Name: "shop.example.",
                Type: "NS",
                TTL: 172800,
                ResourceRecords: NS.map((Value) => ({ Value })),
              },
            ],
            IsTruncated: true,
            NextRecordName: "www.shop.example.",
            NextRecordType: "A",
          };
        }
        expect(input).toMatchObject({ StartRecordName: "www.shop.example.", StartRecordType: "A" });
        return {
          ResourceRecordSets: [
            {
              Name: "www.shop.example.",
              Type: "A",
              TTL: 300,
              ResourceRecords: [{ Value: "203.0.113.10" }],
            },
          ],
          IsTruncated: false,
        };
      },
    });
    const sets = await port.listRecordSets("Z0TESTZONE1");
    expect(sets).toEqual([
      { name: "shop.example.", type: "NS", ttl: 172800, values: NS },
      { name: "www.shop.example.", type: "A", ttl: 300, values: ["203.0.113.10"] },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("fails closed on a set it cannot copy exactly (alias, routing policy)", async () => {
    for (const set of [
      {
        Name: "a.shop.example.",
        Type: "A",
        AliasTarget: { DNSName: "x.", HostedZoneId: "Z", EvaluateTargetHealth: false },
      },
      {
        Name: "b.shop.example.",
        Type: "A",
        TTL: 60,
        SetIdentifier: "one",
        ResourceRecords: [{ Value: "203.0.113.1" }],
      },
    ]) {
      const { port } = fake({
        ListResourceRecordSets: () => ({ ResourceRecordSets: [set], IsTruncated: false }),
      });
      await expect(port.listRecordSets("Z0TESTZONE1")).rejects.toBeInstanceOf(AwsError);
    }
  });

  it("stops at a page limit instead of looping on an answer that never ends", async () => {
    const { port } = fake({
      ListResourceRecordSets: () => ({
        ResourceRecordSets: [],
        IsTruncated: true,
        NextRecordName: "a.shop.example.",
        NextRecordType: "A",
      }),
    });
    await expect(port.listRecordSets("Z0TESTZONE1")).rejects.toBeInstanceOf(AwsError);
  });

  it("maps a missing zone to not_found", async () => {
    const { port } = fake({
      ListResourceRecordSets: () => {
        throw raw("NoSuchHostedZone");
      },
    });
    await expect(port.listRecordSets("Z0GONE")).rejects.toMatchObject({ code: "not_found" });
  });
});

// WPU-Z19 (verify review, JOURNEY.md:1796): "the initial status of the hosted zone is PENDING ... When the NS and SOA
// records are available, the status of the zone changes to INSYNC" (CreateHostedZone); GetChange reads it.
describe("getChangeStatus", () => {
  it("reads GetChange: PENDING is pending, INSYNC is insync", async () => {
    for (const [status, ours] of [
      ["PENDING", "pending"],
      ["INSYNC", "insync"],
    ] as const) {
      const { port, calls } = fake({
        GetChange: () => ({ ChangeInfo: { Id: "/change/C0CHANGE1", Status: status } }),
      });
      expect(await port.getChangeStatus("C0CHANGE1")).toBe(ours);
      expect(calls[0]?.input).toEqual({ Id: "C0CHANGE1" });
    }
  });

  it("an unknown status is an invalid answer, a bad id is refused with no call", async () => {
    const { port, calls } = fake({ GetChange: () => ({ ChangeInfo: { Status: "SOMETHING" } }) });
    await expect(port.getChangeStatus("C0CHANGE1")).rejects.toBeInstanceOf(AwsError);
    calls.length = 0;
    for (const bad of ["", "/change/C1", "c1; x", "C".repeat(40)]) {
      await expect(port.getChangeStatus(bad)).rejects.toMatchObject({ code: "validation" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("changeRecordSets", () => {
  const set = { name: "www.shop.example.", type: "A", ttl: 300, values: ["203.0.113.10"] };

  it("sends ONE batch with every change", async () => {
    const { port, calls } = fake({
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "/change/C1", Status: "PENDING" } }),
    });
    await port.changeRecordSets("Z0TESTZONE1", [
      { action: "CREATE", set },
      { action: "DELETE", set: { ...set, name: "old.shop.example." } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      HostedZoneId: "Z0TESTZONE1",
      ChangeBatch: {
        Changes: [
          {
            Action: "CREATE",
            ResourceRecordSet: {
              Name: "www.shop.example.",
              Type: "A",
              TTL: 300,
              ResourceRecords: [{ Value: "203.0.113.10" }],
            },
          },
          {
            Action: "DELETE",
            ResourceRecordSet: {
              Name: "old.shop.example.",
              Type: "A",
              TTL: 300,
              ResourceRecords: [{ Value: "203.0.113.10" }],
            },
          },
        ],
      },
    });
  });

  it("sends nothing for an empty list", async () => {
    const { port, calls } = fake({});
    await port.changeRecordSets("Z0TESTZONE1", []);
    expect(calls).toHaveLength(0);
  });

  it("refuses a batch over the Route 53 limits, with no call", async () => {
    const { port, calls } = fake({});
    const many = Array.from({ length: 501 }, (_, i) => ({
      action: "CREATE" as const,
      set: { ...set, name: `h${i}.shop.example.` },
    }));
    await expect(port.changeRecordSets("Z0TESTZONE1", many)).rejects.toMatchObject({
      code: "validation",
    });
    const big = [
      {
        action: "CREATE" as const,
        set: { ...set, type: "TXT", values: [`"${"x".repeat(32_001)}"`] },
      },
    ];
    await expect(port.changeRecordSets("Z0TESTZONE1", big)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      port.changeRecordSets("Z0TESTZONE1", [{ action: "DROP" as never, set }]),
    ).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
  });

  // WPU-Z19: the DNS quotas page (DNSLimitations.html): "A request cannot contain more than 1,000 ResourceRecord
  // elements ... When the value of the Action element is UPSERT, each ResourceRecord element is counted twice", and
  // at most 32,000 characters of Value, where an UPSERT's characters also count twice.
  it("counts ResourceRecord elements and value characters, an UPSERT twice", async () => {
    const { port, calls } = fake({
      ChangeResourceRecordSets: () => ({ ChangeInfo: { Id: "/change/C1", Status: "PENDING" } }),
    });
    const values = (n: number) => Array.from({ length: n }, (_, i) => `203.0.113.${i % 250}`);
    const multi = (action: "CREATE" | "UPSERT" | "DELETE", n: number) => ({
      action,
      set: { ...set, values: values(n) },
    });
    // 501 values: 501 elements as a CREATE or DELETE, 1002 as an UPSERT.
    await port.changeRecordSets("Z0TESTZONE1", [multi("CREATE", 501)]);
    await port.changeRecordSets("Z0TESTZONE1", [multi("DELETE", 501)]);
    await expect(
      port.changeRecordSets("Z0TESTZONE1", [multi("UPSERT", 501)]),
    ).rejects.toMatchObject({ code: "validation" });
    await port.changeRecordSets("Z0TESTZONE1", [multi("UPSERT", 500)]);
    // Two DELETEs of 20 values per set: 25 sets is 500 elements; 51 sets of 20 is 1020, over the limit.
    const sets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        action: "DELETE" as const,
        set: { ...set, name: `h${i}.shop.example.`, values: values(20) },
      }));
    await port.changeRecordSets("Z0TESTZONE1", sets(50));
    await expect(port.changeRecordSets("Z0TESTZONE1", sets(51))).rejects.toMatchObject({
      code: "validation",
    });
    // 16,001 characters: allowed once, refused as an UPSERT (32,002).
    const text = (action: "CREATE" | "UPSERT") => ({
      action,
      set: { ...set, type: "TXT", values: [`"${"x".repeat(15_999)}"`] },
    });
    await port.changeRecordSets("Z0TESTZONE1", [text("CREATE")]);
    await expect(port.changeRecordSets("Z0TESTZONE1", [text("UPSERT")])).rejects.toMatchObject({
      code: "validation",
    });
    // Sent: CREATE 501, DELETE 501, UPSERT 500, 50 DELETE sets, the TXT CREATE; every refusal sent nothing.
    expect(calls).toHaveLength(5);
  });

  it("maps a refused batch to conflict and a missing zone to not_found", async () => {
    for (const [name, code] of [
      ["InvalidChangeBatch", "conflict"],
      ["NoSuchHostedZone", "not_found"],
      ["InvalidInput", "validation"],
    ] as const) {
      const { port } = fake({
        ChangeResourceRecordSets: () => {
          throw raw(name);
        },
      });
      const error = await port
        .changeRecordSets("Z0TESTZONE1", [{ action: "UPSERT", set }])
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expectNoLeak(error);
    }
  });
});

describe("deleteHostedZone", () => {
  it("deletes by id", async () => {
    const { port, calls } = fake({
      DeleteHostedZone: () => ({ ChangeInfo: { Id: "/change/C2", Status: "PENDING" } }),
    });
    await port.deleteHostedZone("Z0TESTZONE1");
    expect(calls[0]).toEqual({ op: "DeleteHostedZone", input: { Id: "Z0TESTZONE1" } });
  });
  it("maps a zone that still holds records to conflict and a missing zone to not_found", async () => {
    for (const [name, code] of [
      ["HostedZoneNotEmpty", "conflict"],
      ["NoSuchHostedZone", "not_found"],
    ] as const) {
      const { port } = fake({
        DeleteHostedZone: () => {
          throw raw(name);
        },
      });
      await expect(port.deleteHostedZone("Z0TESTZONE1")).rejects.toMatchObject({ code });
    }
  });
});

describe("findHostedZonesByName", () => {
  it("returns the zones whose name is exactly the name, with their name servers", async () => {
    const { port, calls } = fake({
      ListHostedZonesByName: () => ({
        HostedZones: [
          { Id: "/hostedzone/ZA", Name: "example.com." },
          { Id: "/hostedzone/ZB", Name: "example.com." },
          { Id: "/hostedzone/ZC", Name: "example.org." },
        ],
        IsTruncated: false,
      }),
      GetHostedZone: (input) => hostedZone(String(input.Id), "example.com."),
    });
    const zones = await port.findHostedZonesByName("Example.com");
    expect(zones.map((z) => z.id)).toEqual(["ZA", "ZB"]);
    expect(calls[0]?.input).toMatchObject({ DNSName: "example.com" });
  });
  it("refuses a name that is not a plain host name, with no call", async () => {
    const { port, calls } = fake({});
    await expect(port.findHostedZonesByName("a b")).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
  });
});
