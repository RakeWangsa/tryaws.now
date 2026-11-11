import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  isCellKey,
  POOL_ACCOUNT_STATUSES,
  RESERVATION_AMOUNT_MAX,
  RESERVE_KEY_PREFIX,
  reserveKey,
  type QuotaCode,
} from "../../capacity-keys";
import { RISK_TIERS } from "../../schema/identity";
import { QUOTA_CODES } from "../../schema/provisioning";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminScope } from "./index";

export interface PoolAccountInput {
  awsAccountId: string;
  name: string;
  tier: (typeof RISK_TIERS)[number];
  roleArn: string;
  externalId: string;
  status?: (typeof POOL_ACCOUNT_STATUSES)[number];
  limits?: readonly { region: string; quotaCode: QuotaCode; limit: number }[];
}

export interface PoolAccountAdded {
  id: string;
  name: string;
  tier: string;
  status: string;
}

export interface CapacityLimitInput {
  poolAccountId: string;
  region: string;
  quotaCode: QuotaCode;
  limit: number;
}

export interface CapacityLimitSet {
  id: string;
  poolAccountId: string;
  region: string;
  quotaCode: QuotaCode;
  limit: number;
  used: number;
  overCommitted: boolean;
}

export interface ReserveSetting {
  market: string;
  quotaCode: QuotaCode;
  reserve: number;
}

export interface CapacityRow {
  poolAccountId: string;
  poolName: string;
  tier: string;
  status: string;
  region: string;
  quotaCode: QuotaCode;
  limit: number;
  used: number;
  reserve: number;
  checkedAt: Date | null;
}

export interface CapacityAdminRepo {
  addPoolAccount(input: PoolAccountInput, why: string): Promise<Written<PoolAccountAdded>>;
  setLimit(input: CapacityLimitInput, why: string): Promise<Written<CapacityLimitSet>>;
  setReserve(input: ReserveSetting, why: string): Promise<Written<ReserveSetting>>;
  list(market: string): Promise<CapacityRow[]>;
}

const MAX_LIMITS = 40;
const LIMIT_MAX = 1_000_000;
const NAME_PATTERN = /^tc-pool-[a-z0-9]{1,12}$/;
const ROLE_PATTERN = /^arn:aws:iam::([0-9]{12}):role\/TcProvisioner$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_+=,.@:/-]{2,128}$/;
const MARKET_PATTERN = /^[A-Z]{2}$/;

// Thrown inside the audited write, before anything is written, so that a refusal writes no audit row.
class Refused extends Error {
  constructor(readonly code: "conflict") {
    super(code);
  }
}

const isWholeNumber = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

interface Found {
  id: string;
  name: string;
  tier: string;
  status: string;
}

interface Limits {
  region: string;
  quotaCode: string;
  limit: number;
}

export function capacityAdminRepo(scope: AdminScope): CapacityAdminRepo {
  const { tx, actor } = scope;

  const findPool = async (name: string): Promise<Found | undefined> => {
    const { rows } = await tx.execute<Found & Record<string, unknown>>(
      sql`select id, name, tier, status from pool_accounts where name = ${name}`,
    );
    return rows[0];
  };

  // A found account is the same request again only when tier, status and every requested limit
  // equal the stored ones (extra stored cells are ignored).
  const sameAs = async (
    found: Found,
    tier: string,
    status: string,
    limits: readonly Limits[],
  ): Promise<boolean> => {
    if (found.tier !== tier || found.status !== status) return false;
    const { rows } = await tx.execute<Limits & Record<string, unknown>>(
      sql`select region, quota_code as "quotaCode", quota_limit as "limit"
            from pool_capacity where pool_account_id = ${found.id}`,
    );
    return limits.every((want) =>
      rows.some(
        (have) =>
          have.region === want.region &&
          have.quotaCode === want.quotaCode &&
          have.limit === want.limit,
      ),
    );
  };

  return {
    async addPoolAccount(input, why) {
      const { awsAccountId, name, tier, roleArn, externalId } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      const status = input.status ?? "active";
      const limits = input.limits ?? [];
      const arn = typeof roleArn === "string" ? ROLE_PATTERN.exec(roleArn) : null;
      if (
        typeof awsAccountId !== "string" ||
        !/^[0-9]{12}$/.test(awsAccountId) ||
        typeof name !== "string" ||
        !NAME_PATTERN.test(name) ||
        !(RISK_TIERS as readonly unknown[]).includes(tier) ||
        !(POOL_ACCOUNT_STATUSES as readonly unknown[]).includes(status) ||
        arn === null ||
        arn[1] !== awsAccountId ||
        typeof externalId !== "string" ||
        !EXTERNAL_ID_PATTERN.test(externalId) ||
        !Array.isArray(limits) ||
        limits.length > MAX_LIMITS ||
        !limits.every(
          (l) =>
            typeof l === "object" &&
            l !== null &&
            typeof l.region === "string" &&
            typeof l.quotaCode === "string" &&
            isCellKey(l.quotaCode, l.region) &&
            isWholeNumber(l.limit, LIMIT_MAX),
        ) ||
        new Set(limits.map((l) => `${l.region}/${l.quotaCode}`)).size !== limits.length
      ) {
        return refused("validation");
      }
      const wanted: Limits[] = limits.map((l) => ({
        region: l.region,
        quotaCode: l.quotaCode,
        limit: l.limit,
      }));
      const entry = (targetId: string) => ({
        action: "pool_account.add",
        targetType: "pool_account",
        targetId,
        reason: why,
      });
      const added = (row: Found) => ({
        id: row.id,
        name: row.name,
        tier: row.tier,
        status: row.status,
      });
      const replay = (row: Found) => ({
        value: added(row),
        replayed: true,
        before: null,
        after: { ...added(row), limits: wanted },
      });

      try {
        const existing = await findPool(name);
        if (existing !== undefined) {
          if (!(await sameAs(existing, tier, status, wanted))) return refused("conflict");
          return await audited(scope, entry(existing.id), async () => replay(existing));
        }
        const id = uuidv7();
        return await audited(scope, entry(id), async () => {
          const { rows } = await tx.execute<{ id: string } & Record<string, unknown>>(
            sql`insert into pool_accounts (id, aws_account_id, name, tier, role_arn, external_id, status)
                values (${id}, ${awsAccountId}, ${name}, ${tier}, ${roleArn}, ${externalId}, ${status})
                on conflict do nothing returning id`,
          );
          if (rows.length === 0) {
            // The same call arrived twice at the same moment (equal: a replay), or the name or the
            // AWS account is taken by a different request. Nothing has been written yet.
            const now = await findPool(name);
            if (now === undefined || !(await sameAs(now, tier, status, wanted))) {
              throw new Refused("conflict");
            }
            return replay(now);
          }
          for (const l of wanted) {
            await tx.execute(
              sql`insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit)
                  values (${uuidv7()}, ${id}, ${l.region}, ${l.quotaCode}, ${l.limit})`,
            );
          }
          const value = { id, name, tier, status };
          return { value, replayed: false, before: null, after: { ...value, limits: wanted } };
        });
      } catch (error) {
        if (error instanceof Refused) return refused(error.code);
        throw error;
      }
    },

    async setLimit(input, why) {
      const { poolAccountId, region, quotaCode, limit } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        typeof poolAccountId !== "string" ||
        !isUuid(poolAccountId) ||
        typeof region !== "string" ||
        typeof quotaCode !== "string" ||
        !isCellKey(quotaCode, region) ||
        !isWholeNumber(limit, LIMIT_MAX)
      ) {
        return refused("validation");
      }
      const account = await tx.execute(
        sql`select id from pool_accounts where id = ${poolAccountId}`,
      );
      if (account.rows.length === 0) return refused("not_found");
      return audited(
        scope,
        {
          action: "capacity.set_limit",
          targetType: "pool_capacity",
          targetId: `${poolAccountId}:${region}:${quotaCode}`,
          reason: why,
        },
        async () => {
          const current = await tx.execute<{ limit: number } & Record<string, unknown>>(
            sql`select quota_limit as "limit" from pool_capacity
                 where pool_account_id = ${poolAccountId} and region = ${region} and quota_code = ${quotaCode}
                   for update`,
          );
          const before = current.rows[0] === undefined ? null : { limit: current.rows[0].limit };
          const { rows } = await tx.execute<
            { id: string; limit: number; used: number } & Record<string, unknown>
          >(
            sql`insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit)
                values (${uuidv7()}, ${poolAccountId}, ${region}, ${quotaCode}, ${limit})
                on conflict (pool_account_id, region, quota_code)
                do update set quota_limit = excluded.quota_limit
                returning id, quota_limit as "limit", used`,
          );
          const row = rows[0]!;
          return {
            value: {
              id: row.id,
              poolAccountId,
              region,
              quotaCode,
              limit: row.limit,
              used: row.used,
              overCommitted: row.used > row.limit,
            },
            replayed: before?.limit === limit,
            before,
            after: { limit },
          };
        },
      );
    },

    async setReserve(input, why) {
      const { market, quotaCode, reserve } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        typeof market !== "string" ||
        !MARKET_PATTERN.test(market) ||
        !(QUOTA_CODES as readonly unknown[]).includes(quotaCode) ||
        !isWholeNumber(reserve, RESERVATION_AMOUNT_MAX)
      ) {
        return refused("validation");
      }
      const known = await tx.execute(sql`select 1 from markets where code = ${market}`);
      if (known.rows.length === 0) return refused("not_found");
      const key = reserveKey(quotaCode);
      return audited(
        scope,
        {
          action: "capacity.set_reserve",
          targetType: "setting",
          targetId: `${market}:${key}`,
          reason: why,
        },
        async () => {
          const current = await tx.execute<{ value: unknown } & Record<string, unknown>>(
            sql`select value from settings
                 where key = ${key} and market = ${market} and scope = 'market' and scope_id is null
                   for update`,
          );
          const before = current.rows[0] === undefined ? null : { reserve: current.rows[0].value };
          await tx.execute(
            sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                values (${uuidv7()}, ${key}, ${market}, 'market', null, ${JSON.stringify(reserve)}::jsonb, ${actor.adminId})
                on conflict (key, market, scope, scope_id)
                do update set value = excluded.value, set_by = excluded.set_by`,
          );
          return {
            value: { market, quotaCode, reserve },
            replayed: before?.reserve === reserve,
            before,
            after: { reserve },
          };
        },
      );
    },

    async list(market) {
      if (typeof market !== "string" || !MARKET_PATTERN.test(market)) {
        throw new TypeError("capacity: the market is not valid");
      }
      const { rows } = await tx.execute<
        {
          poolAccountId: string;
          poolName: string;
          tier: string;
          status: string;
          region: string;
          quotaCode: QuotaCode;
          limit: number;
          used: number;
          checkedAt: string | Date | null;
          reserveValue: unknown;
        } & Record<string, unknown>
      >(
        sql`select a.id as "poolAccountId", a.name as "poolName", a.tier, a.status, pc.region,
                   pc.quota_code as "quotaCode", pc.quota_limit as "limit", pc.used,
                   pc.checked_at as "checkedAt", s.value as "reserveValue"
              from pool_capacity pc
              join pool_accounts a on a.id = pc.pool_account_id
              left join settings s on s.key = ${RESERVE_KEY_PREFIX}::text || pc.quota_code
                                  and s.market = ${market} and s.scope = 'market'
             order by a.id, pc.region, pc.quota_code`,
      );
      return rows.map(({ reserveValue, checkedAt, ...row }) => ({
        ...row,
        // The screen shows a stored value that readReserves would reject; it is not a purchase.
        reserve: typeof reserveValue === "number" ? reserveValue : 0,
        checkedAt: checkedAt === null ? null : new Date(checkedAt),
      }));
    },
  };
}
