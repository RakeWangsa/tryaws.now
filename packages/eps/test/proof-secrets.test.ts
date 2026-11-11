import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createEps,
  createEpsGateway,
  epsCredentials,
  handleEpsReturn,
  startTopUp,
  sweepPayments,
  verifyPayment,
} from "../index";
import { epsHash } from "../hash";
import { freshIp, useEpsKit } from "./kit";

// R14 proof: a full start, verify, mismatch, failure and sweep with planted secrets. Everything the
// package logs, throws, returns, stores or raises is searched for each planted value.

const k = useEpsKit();

const HASH_KEY = "planted-hash-key-" + "q7".repeat(12);
const PASSWORD = "planted-password-" + "z9".repeat(10);
const USERNAME = "planted-user-" + "u3".repeat(6);
const TOKEN = "planted-token-" + "t5".repeat(12);
const REDIRECT_QUERY = "PLANTED-REDIRECT-" + "r8".repeat(8);
const REDIRECT_URL = `https://pg.eps.com.bd/PG?data=${REDIRECT_QUERY}`;
const MIN = 60_000;

const creds = epsCredentials({
  mode: "sandbox",
  merchantId: "planted-merchant-0001",
  storeId: "planted-store-0001",
  username: USERNAME,
  password: PASSWORD,
  hashKey: HASH_KEY,
});

type Scenario = "success" | "mismatch" | "server_error" | "reject_init";

/** A scripted EPS over fetch: the real client, with the real hash headers, answering by scenario. */
function scriptedEps(plan: {
  init: Scenario;
  verify: Map<string, Scenario>;
  amounts: Map<string, string>;
}) {
  const sentHashes = new Set<string>();
  const ids: string[] = [];
  const fetchStub = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const hash = headers.get("x-hash");
    if (hash !== null) sentHashes.add(hash);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/Auth/GetToken")) {
      return json({ token: TOKEN, expireDate: "2099-01-01T00:00:00.0000000", errorCode: null });
    }
    if (url.includes("/InitializeEPS")) {
      const sent = JSON.parse(String(init?.body)) as { merchantTransactionId: string };
      const total = /"totalAmount":([0-9.]+)/.exec(String(init?.body))?.[1] ?? "0";
      plan.amounts.set(sent.merchantTransactionId, total);
      ids.push(sent.merchantTransactionId);
      if (plan.init === "reject_init") {
        return json({ ErrorCode: "E-planted", ErrorMessage: `${PASSWORD} ${HASH_KEY} ${TOKEN}` });
      }
      return json({
        TransactionId: "EPS-" + ids.length,
        RedirectURL: REDIRECT_URL,
        ErrorCode: null,
      });
    }
    const id = new URL(url).searchParams.get("merchantTransactionId") ?? "";
    const scenario = plan.verify.get(id) ?? "success";
    if (scenario === "server_error") {
      return json({ message: `${HASH_KEY} ${PASSWORD} ${TOKEN} ${REDIRECT_URL}` }, 500);
    }
    return json({
      Status: "Success",
      MerchantTransactionId: id,
      EpsTransactionId: "EPS-V-" + id.slice(3, 11),
      TotalAmount: scenario === "mismatch" ? "1.00" : (plan.amounts.get(id) ?? "0.00"),
      ErrorCode: "",
      // fields the package must never store or pass on
      Echo: { hashKey: HASH_KEY, password: PASSWORD, token: TOKEN, redirect: REDIRECT_URL },
    });
  }) as typeof fetch;
  return { fetchStub, sentHashes, ids };
}

describe("no secret reaches a log, an error, a result, a stored payload, an audit row or an alert", () => {
  it("runs start, credit, mismatch, EPS errors and the sweeper with planted secrets", async () => {
    k.reset();
    const plan = {
      init: "success" as Scenario,
      verify: new Map<string, Scenario>(),
      amounts: new Map<string, string>(),
    };
    const eps = scriptedEps(plan);
    const gateway = createEpsGateway(creds, { fetch: eps.fetchStub, clock: k.clock });
    const deps = k.deps("web_rw", { gateway });
    const worker = k.deps("worker_rw", { gateway });

    const results: unknown[] = [];
    const thrown: string[] = [];
    const record = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
      try {
        const r = await call();
        results.push(r);
        return r;
      } catch (e) {
        thrown.push(String(e instanceof Error ? e.message + (e.stack ?? "") : e));
        return undefined;
      }
    };
    const start = async (amountMinor: bigint) => {
      const customerId = await k.newCustomer();
      const r = await record(() =>
        startTopUp(
          deps,
          { customerId },
          { amountMinor, idempotencyKey: "secret-" + crypto.randomUUID() },
          { clientIp: freshIp() },
        ),
      );
      if (r === undefined || !r.ok) throw new Error("start did not succeed in the planted run");
      const row = await k.payment(r.value.paymentId);
      return { customerId, paymentId: r.value.paymentId, id: row.merchantTransactionId };
    };
    const back = async (id: string, outcome: "success" | "fail" | "cancel" = "success") => {
      k.clock.advance(6000);
      return record(() =>
        handleEpsReturn(deps, {
          outcome,
          query: { MerchantTransactionId: id, Status: "Success", token: TOKEN, hashKey: HASH_KEY },
          clientIp: freshIp(),
        }),
      );
    };

    // 1. a full credit
    const paid = await start(150000n);
    await back(paid.id);
    await back(paid.id);
    // 2. an amount mismatch (review, discrepancy, alert)
    const wrong = await start(250000n);
    plan.verify.set(wrong.id, "mismatch");
    await back(wrong.id);
    // 3. EPS answers 500 with the secrets in the body
    const down = await start(100000n);
    plan.verify.set(down.id, "server_error");
    await back(down.id);
    await record(() => verifyPayment(deps, down.id));
    // 4. InitializeEPS rejected with the secrets in the error text
    plan.init = "reject_init";
    const customerId = await k.newCustomer();
    await record(() =>
      startTopUp(
        deps,
        { customerId },
        { amountMinor: 120000n, idempotencyKey: "secret-" + crypto.randomUUID() },
        { clientIp: freshIp() },
      ),
    );
    plan.init = "success";
    // 5. the sweeper credits an old payment and meets the broken one again
    const old = await start(130000n);
    await k.pool.query(
      "update payments set status = 'cancelled' where status in ('initiated','redirected') and id not in ($1, $2)",
      [old.paymentId, down.paymentId],
    );
    const created = await k.pool.query<{ created_at: Date }>(
      "select created_at from payments where id = $1",
      [old.paymentId],
    );
    k.clock.set(new Date((created.rows[0]?.created_at.getTime() ?? 0) + 3 * MIN));
    await record(() => sweepPayments(worker));
    // 6. the bound services and the guards
    const bound = createEps(deps);
    await record(() => bound.verifyPayment(paid.id));
    await record(() => bound.handleReturn({ outcome: "fail", query: {}, clientIp: freshIp() }));
    await record(() => Promise.reject(new Error("probe")).catch(() => undefined));
    try {
      epsCredentials({ ...creds, hashKey: "" });
    } catch (e) {
      thrown.push(String(e instanceof Error ? e.message : e));
    }

    // sanity: the planted flows really ran
    expect((await k.payment(paid.paymentId)).status).toBe("credited");
    expect((await k.payment(wrong.paymentId)).status).toBe("review");
    expect((await k.payment(old.paymentId)).status).toBe("credited");
    expect(k.alerts.length).toBeGreaterThanOrEqual(1);
    expect(k.logs.length).toBeGreaterThan(5);
    expect(eps.sentHashes.size).toBeGreaterThan(2);

    // everything that was stored
    const stored = await k.pool.query<{ doc: unknown }>(
      `select verify_payload as doc from payments where verify_payload is not null
       union all select details from discrepancies
       union all select to_jsonb(a) from audit_log a`,
    );
    const payloads = (
      await k.pool.query<{ verify_payload: unknown; merchant_transaction_id: string }>(
        "select verify_payload, merchant_transaction_id from payments where verify_payload is not null",
      )
    ).rows;

    // the planted values, each form in which it could leak
    const merchantIds = [paid.id, wrong.id, down.id, old.id];
    const secrets = [
      HASH_KEY,
      PASSWORD,
      USERNAME,
      TOKEN,
      REDIRECT_URL,
      REDIRECT_QUERY,
      ...eps.sentHashes,
      ...merchantIds.map((id) => epsHash(HASH_KEY, id)),
    ];
    const text = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

    // The one place the redirect URL is meant to appear: the value of a successful startTopUp, which
    // the caller sends the customer to. It must be exactly the URL EPS gave, and nothing else may hold it.
    const handedOver: string[] = [];
    const resultsWithoutRedirect = results.map((r) => {
      const v = (r as { ok?: boolean; value?: { redirectUrl?: unknown } } | null)?.value;
      if (v !== undefined && v !== null && typeof v.redirectUrl === "string") {
        handedOver.push(v.redirectUrl);
        return { ...(r as object), value: { ...v, redirectUrl: "[handed to the caller]" } };
      }
      return r;
    });
    expect(handedOver.length).toBeGreaterThanOrEqual(1);
    for (const url of handedOver) expect(url).toBe(REDIRECT_URL);

    const surfaces: Array<[string, string]> = [
      ["log lines", text(k.logs)],
      ["thrown errors", thrown.join("\n")],
      ["returned results", text(resultsWithoutRedirect)],
      ["alert events", text(k.alerts)],
      ["stored documents (payload, discrepancies, audit_log)", text(stored.rows)],
      [
        "credentials as text",
        `${creds}|${JSON.stringify(creds)}|${inspect(creds)}|${String(creds)}`,
      ],
    ];
    for (const [surface, body] of surfaces) {
      for (const secret of secrets) {
        expect(body.includes(secret), `${surface} holds a planted value`).toBe(false);
      }
    }

    // the merchant transaction id never reaches a log, an error, a result, an alert, a
    // discrepancy or the audit log. The verify payload is the one exception by design (pinned by
    // verify.test): it holds the id of its own row, and only that id.
    const idSurfaces: Array<[string, string]> = [
      ["log lines", text(k.logs)],
      ["thrown errors", thrown.join("\n")],
      ["returned results", text(resultsWithoutRedirect)],
      ["alert events", text(k.alerts)],
      [
        "discrepancies and audit_log",
        text(
          (
            await k.pool.query(
              "select details as doc from discrepancies union all select to_jsonb(a) from audit_log a",
            )
          ).rows,
        ),
      ],
    ];
    for (const [surface, body] of idSurfaces) {
      for (const id of merchantIds) {
        expect(body.includes(id), `${surface} holds a merchant transaction id`).toBe(false);
      }
    }
    for (const row of payloads) {
      const doc = row.verify_payload as Record<string, unknown>;
      expect(Object.keys(doc).sort()).toEqual([
        "epsTransactionId",
        "merchantTransactionId",
        "status",
        "totalAmount",
      ]);
      expect([row.merchant_transaction_id, null]).toContain(doc.merchantTransactionId);
    }
  });
});
