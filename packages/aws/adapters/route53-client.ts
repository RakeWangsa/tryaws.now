import {
  ChangeResourceRecordSetsCommand,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetChangeCommand,
  GetHostedZoneCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  type ChangeResourceRecordSetsCommandInput,
  type RRType,
  type Route53Client,
} from "@aws-sdk/client-route-53";
import { validateZoneName } from "@tc/core";
import { AwsError, toAwsError } from "../errors";
import type { R53Change, R53RecordSet, R53Zone, Route53Port } from "./route53-port";
import { withinBatchLimits } from "./route53-limits";

// WPU-D4: the real Route 53 client behind Route53Port (the tc-dns account; the role is assumed by
// access.route53, R3). Rules:
// - Every id, name, reference and comment is checked here again before a call: a hosted zone id is
//   [A-Z0-9]{1,32}, a name passes validateZoneName, the caller reference is a UUID-like token and the
//   comment is the generated `tc-dnszone-<16 hex>` (R11). Customer text reaches Route 53 only as the zone
//   name and the record contents that the core validated.
// - Errors are AwsError values with a platform code and no AWS text (R14). The Route 53 names that the
//   shared table does not know are decided here (NoSuchHostedZone, HostedZoneAlreadyExists, ...).
// - A record set that cannot be copied exactly (alias, routing policy) fails the read (R16): a later
//   DELETE needs the exact copy.
// WPU-Z19, checked against the Route 53 API reference and quotas page on 2026-11-14: CreateHostedZone answers
// HostedZoneAlreadyExists (HTTP 409) for a used CallerReference; ListHostedZonesByName returns Config.Comment;
// ListResourceRecordSets pages by NextRecordName, NextRecordType and NextRecordIdentifier. One
// ChangeResourceRecordSets request holds at most 1,000 ResourceRecord elements and 32,000 characters of Value, and
// an UPSERT counts both twice (route53-limits.ts); the platform also caps a batch at 500 changes.

/** The one method of the SDK client that this file uses (the tests pass a fake). */
export interface Route53Like {
  send(command: never): Promise<unknown>;
}

const HOSTED_ZONE_ID = /^[A-Z0-9]{1,32}$/;
const CALLER_REFERENCE = /^[A-Za-z0-9-]{8,128}$/;
const GENERATED_COMMENT = /^tc-dnszone-[0-9a-f]{16}$/;
const RECORD_TYPE = /^[A-Z]{1,10}$/;
// Names as Route 53 spells them: letters, digits, hyphen, underscore, dot, and \ooo escapes ("*" is \052).
const RECORD_NAME = /^[A-Za-z0-9_.\\*-]{1,255}$/;
const MAX_PAGES = 100;
const MAX_ZONE_PAGES = 20;

function validation(operation: string): AwsError {
  return new AwsError({ code: "validation", retryable: false, operation });
}

function invalidAnswer(operation: string): AwsError {
  return new AwsError({
    code: "upstream_unavailable",
    retryable: true,
    awsErrorName: "InvalidResponse",
    operation,
    mayHaveActed: true,
  });
}

const NAMES = {
  notFound: new Set(["NoSuchHostedZone", "NoSuchChange"]),
  conflict: new Set([
    "HostedZoneAlreadyExists",
    "ConflictingDomainExists",
    "HostedZoneNotEmpty",
    "InvalidChangeBatch",
  ]),
  validation: new Set([
    "InvalidDomainName",
    "InvalidInput",
    "InvalidArgument",
    "DelegationSetNotAvailable",
    "DelegationSetNotReusable",
  ]),
  quota: new Set(["TooManyHostedZones"]),
};

function errorName(error: unknown): string | null {
  if (error instanceof AwsError) return error.awsErrorName;
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return null;
}

/** The AwsError for a failed Route 53 call: Route 53's own names first, then the shared table. */
function fail(error: unknown, operation: string): AwsError {
  const name = errorName(error);
  if (name !== null) {
    if (NAMES.notFound.has(name)) {
      return new AwsError({ code: "not_found", retryable: false, awsErrorName: name, operation });
    }
    if (NAMES.conflict.has(name)) {
      return new AwsError({ code: "conflict", retryable: false, awsErrorName: name, operation });
    }
    if (NAMES.validation.has(name)) {
      return new AwsError({ code: "validation", retryable: false, awsErrorName: name, operation });
    }
    if (NAMES.quota.has(name)) {
      return new AwsError({
        code: "capacity_full",
        retryable: false,
        awsErrorName: name,
        operation,
      });
    }
  }
  return toAwsError(error, operation);
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof AwsError && error.code === code;

// WPU-Z19: the id of a change, as GetChange takes it.
const CHANGE_ID = /^[A-Z0-9]{1,32}$/;

/** ChangeInfo.Id without "/change/"; null when the answer has none that is well formed. */
function changeIdOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.startsWith("/change/") ? raw.slice("/change/".length) : raw;
  return CHANGE_ID.test(id) ? id : null;
}

function plainId(raw: unknown, operation: string): string {
  if (typeof raw !== "string") throw invalidAnswer(operation);
  const id = raw.startsWith("/hostedzone/") ? raw.slice("/hostedzone/".length) : raw;
  if (!HOSTED_ZONE_ID.test(id)) throw invalidAnswer(operation);
  return id;
}

function checkedId(id: unknown, operation: string): string {
  if (typeof id !== "string" || !HOSTED_ZONE_ID.test(id)) throw validation(operation);
  return id;
}

function zoneOf(
  answer: {
    HostedZone?: { Id?: string; Name?: string } | undefined;
    DelegationSet?: { NameServers?: string[] | undefined } | undefined;
  },
  operation: string,
): R53Zone {
  const zone = answer.HostedZone;
  const servers = answer.DelegationSet?.NameServers;
  if (
    zone === undefined ||
    typeof zone.Name !== "string" ||
    zone.Name === "" ||
    !Array.isArray(servers) ||
    servers.length === 0 ||
    !servers.every((s) => typeof s === "string" && s !== "")
  ) {
    throw invalidAnswer(operation);
  }
  return { id: plainId(zone.Id, operation), name: zone.Name, nameServers: [...servers] };
}

const dotted = (name: string): string => `${name.replace(/\.$/, "").toLowerCase()}.`;

export function createRoute53Port(client: Route53Like | Route53Client): Route53Port {
  const send = async <T>(command: unknown, operation: string): Promise<T> => {
    try {
      return (await (client as Route53Like).send(command as never)) as T;
    } catch (error) {
      throw fail(error, operation);
    }
  };

  const getZone = async (id: string): Promise<R53Zone | null> => {
    try {
      const out = await send<Parameters<typeof zoneOf>[0]>(
        new GetHostedZoneCommand({ Id: id }),
        "GetHostedZone",
      );
      return zoneOf(out, "GetHostedZone");
    } catch (error) {
      if (isCode(error, "not_found")) return null;
      throw error;
    }
  };

  async function zonesNamed(name: string): Promise<{ id: string; comment: string | null }[]> {
    const wanted = dotted(name);
    const found: { id: string; comment: string | null }[] = [];
    let marker: { DNSName?: string; HostedZoneId?: string } = { DNSName: name };
    for (let page = 0; page < MAX_ZONE_PAGES; page++) {
      const out = await send<{
        HostedZones?: { Id?: string; Name?: string; Config?: { Comment?: string } }[];
        IsTruncated?: boolean;
        NextDNSName?: string;
        NextHostedZoneId?: string;
      }>(new ListHostedZonesByNameCommand(marker), "ListHostedZonesByName");
      for (const z of out.HostedZones ?? []) {
        if (typeof z.Name === "string" && dotted(z.Name) === wanted) {
          found.push({
            id: plainId(z.Id, "ListHostedZonesByName"),
            comment: z.Config?.Comment ?? null,
          });
        }
      }
      if (out.IsTruncated !== true) return found;
      if (typeof out.NextDNSName !== "string") throw invalidAnswer("ListHostedZonesByName");
      // The list is sorted by name: once the next name is another name, no more zone of this name follows.
      if (dotted(out.NextDNSName) !== wanted) return found;
      marker = {
        DNSName: out.NextDNSName,
        ...(typeof out.NextHostedZoneId === "string" ? { HostedZoneId: out.NextHostedZoneId } : {}),
      };
    }
    throw invalidAnswer("ListHostedZonesByName");
  }

  return {
    async createHostedZone(input) {
      const name = validateZoneName(input.name);
      if (
        !name.ok ||
        typeof input.callerReference !== "string" ||
        !CALLER_REFERENCE.test(input.callerReference) ||
        typeof input.comment !== "string" ||
        !GENERATED_COMMENT.test(input.comment)
      ) {
        throw validation("CreateHostedZone");
      }
      try {
        const out = await send<Parameters<typeof zoneOf>[0] & { ChangeInfo?: { Id?: string } }>(
          new CreateHostedZoneCommand({
            Name: name.value,
            CallerReference: input.callerReference,
            HostedZoneConfig: { Comment: input.comment, PrivateZone: false },
          }),
          "CreateHostedZone",
        );
        return {
          zone: zoneOf(out, "CreateHostedZone"),
          created: true,
          changeId: changeIdOf(out.ChangeInfo?.Id),
        };
      } catch (error) {
        // The reference was used: the first call made the zone. Find it by its name and its generated
        // comment (the comment is unique per resource), or fail closed.
        if (errorName(error) !== "HostedZoneAlreadyExists") throw error;
        const mine = (await zonesNamed(name.value)).filter((z) => z.comment === input.comment);
        if (mine.length !== 1) {
          throw new AwsError({
            code: "conflict",
            retryable: false,
            awsErrorName: "HostedZoneAlreadyExists",
            operation: "CreateHostedZone",
          });
        }
        const zone = await getZone((mine[0] as { id: string }).id);
        if (zone === null) throw invalidAnswer("CreateHostedZone");
        return { zone, created: false, changeId: null };
      }
    },

    async getChangeStatus(changeId) {
      if (typeof changeId !== "string" || !CHANGE_ID.test(changeId)) throw validation("GetChange");
      const out = await send<{ ChangeInfo?: { Status?: string } }>(
        new GetChangeCommand({ Id: changeId }),
        "GetChange",
      );
      const status = out.ChangeInfo?.Status;
      if (status === "PENDING") return "pending";
      if (status === "INSYNC") return "insync";
      throw invalidAnswer("GetChange");
    },

    async getHostedZone(hostedZoneId) {
      return getZone(checkedId(hostedZoneId, "GetHostedZone"));
    },

    async findHostedZonesByName(name) {
      const checked = validateZoneName(name);
      if (!checked.ok) throw validation("ListHostedZonesByName");
      const zones: R53Zone[] = [];
      for (const { id } of await zonesNamed(checked.value)) {
        const zone = await getZone(id);
        if (zone !== null) zones.push(zone);
      }
      return zones;
    },

    async listRecordSets(hostedZoneId) {
      const id = checkedId(hostedZoneId, "ListResourceRecordSets");
      const sets: R53RecordSet[] = [];
      let start: {
        StartRecordName?: string;
        StartRecordType?: RRType;
        StartRecordIdentifier?: string;
      } = {};
      for (let page = 0; page < MAX_PAGES; page++) {
        const out = await send<{
          ResourceRecordSets?: {
            Name?: string;
            Type?: string;
            TTL?: number;
            ResourceRecords?: { Value?: string }[];
            AliasTarget?: unknown;
            SetIdentifier?: string;
          }[];
          IsTruncated?: boolean;
          NextRecordName?: string;
          NextRecordType?: RRType;
          NextRecordIdentifier?: string;
        }>(
          new ListResourceRecordSetsCommand({ HostedZoneId: id, ...start }),
          "ListResourceRecordSets",
        );
        for (const s of out.ResourceRecordSets ?? []) {
          const values = (s.ResourceRecords ?? []).map((r) => r.Value);
          if (
            typeof s.Name !== "string" ||
            typeof s.Type !== "string" ||
            typeof s.TTL !== "number" ||
            s.AliasTarget !== undefined ||
            s.SetIdentifier !== undefined ||
            values.length === 0 ||
            !values.every((v): v is string => typeof v === "string" && v !== "")
          ) {
            throw invalidAnswer("ListResourceRecordSets");
          }
          sets.push({ name: s.Name, type: s.Type, ttl: s.TTL, values });
        }
        if (out.IsTruncated !== true) return sets;
        if (typeof out.NextRecordName !== "string" || out.NextRecordType === undefined) {
          throw invalidAnswer("ListResourceRecordSets");
        }
        start = {
          StartRecordName: out.NextRecordName,
          StartRecordType: out.NextRecordType,
          ...(typeof out.NextRecordIdentifier === "string"
            ? { StartRecordIdentifier: out.NextRecordIdentifier }
            : {}),
        };
      }
      throw invalidAnswer("ListResourceRecordSets");
    },

    async changeRecordSets(hostedZoneId, changes) {
      const id = checkedId(hostedZoneId, "ChangeResourceRecordSets");
      if (!Array.isArray(changes)) throw validation("ChangeResourceRecordSets");
      if (changes.length === 0) return;
      const batch: NonNullable<ChangeResourceRecordSetsCommandInput["ChangeBatch"]>["Changes"] = [];
      for (const change of changes as readonly R53Change[]) {
        const { action, set } = change;
        if (
          (action !== "CREATE" && action !== "UPSERT" && action !== "DELETE") ||
          typeof set?.name !== "string" ||
          !RECORD_NAME.test(set.name) ||
          typeof set.type !== "string" ||
          !RECORD_TYPE.test(set.type) ||
          !Number.isInteger(set.ttl) ||
          set.ttl < 0 ||
          !Array.isArray(set.values) ||
          set.values.length === 0 ||
          !set.values.every((v) => typeof v === "string" && v !== "")
        ) {
          throw validation("ChangeResourceRecordSets");
        }
        batch.push({
          Action: action,
          ResourceRecordSet: {
            Name: set.name,
            Type: set.type as RRType,
            TTL: set.ttl,
            ResourceRecords: set.values.map((Value) => ({ Value })),
          },
        });
      }
      // The elements and characters of every change, an UPSERT twice; over the limits is refused before the call.
      if (!withinBatchLimits(changes as readonly R53Change[])) {
        throw validation("ChangeResourceRecordSets");
      }
      await send(
        new ChangeResourceRecordSetsCommand({ HostedZoneId: id, ChangeBatch: { Changes: batch } }),
        "ChangeResourceRecordSets",
      );
    },

    async deleteHostedZone(hostedZoneId) {
      const id = checkedId(hostedZoneId, "DeleteHostedZone");
      await send(new DeleteHostedZoneCommand({ Id: id }), "DeleteHostedZone");
    },
  };
}
