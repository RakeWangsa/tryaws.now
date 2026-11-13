// WPU-B3 (audit items 14, 15, 21, 36): the alerts of infra/stacks/alarms.ts, proven by reading source text
// (SST is not installed here). The point of the test: every log event that an alarm matches is really
// written by the code that is named in infra/lib/functions.ts, so that a rename cannot silence an alarm,
// and every function with a schedule or a queue has an error alarm.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const raw = (file) => readFileSync(resolve(root, file), "utf8");
const code = (file) =>
  raw(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");

const alarms = code("infra/stacks/alarms.ts");
const functions = raw("infra/lib/functions.ts");

function constantsOfInfra(name) {
  const block = functions.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`));
  expect(block, name).not.toBeNull();
  return Object.fromEntries(
    [...block[1].matchAll(/^\s*(\w+): "([a-z_]+)",?$/gm)].map((m) => [m[1], m[2]]),
  );
}
const eventsOfInfra = () => constantsOfInfra("ALERT_LOG_EVENTS");

describe("the log events of the alerts exist in the code that writes them", () => {
  const events = eventsOfInfra();
  const writers = {
    capacityReleaseProblem: "packages/core/capacity/release.ts",
    creditNoteStuck: "packages/core/invoices/credit-note.ts",
    fxRateStaleWarning: "packages/core/rates/fx-watch.ts",
    lifecycleRenewalHeld: "packages/core/lifecycle/engine.ts",
    reconcileFindings: "functions/reconciler/reconcile.ts",
    reconcileIncomplete: "functions/reconciler/reconcile.ts",
    reconcileStaleOperations: "functions/reconciler/reconcile.ts",
    reconcileUsageFailed: "functions/reconciler/reconcile.ts",
    reconcileOk: "functions/reconciler/reconcile.ts",
    notifierSmsOff: "functions/notifier/build.ts",
  };

  it("names exactly the events that have a writer in this test", () => {
    expect(Object.keys(events).sort()).toEqual(Object.keys(writers).sort());
  });

  it.each(Object.entries(writers))("%s is written by %s", (key, file) => {
    const text = raw(file);
    const name = events[key];
    // Either the literal as the value of `event`, or the exported constant that holds it.
    const literal = new RegExp(`event: "${name}"`).test(text);
    const constant = new RegExp(`= "${name}"`).test(text);
    expect(literal || constant, `${name} in ${file}`).toBe(true);
  });

  // WPU-Z1: an alert that matches a `reason` next to the event. The value is written by the same code, so a
  // rename of either cannot silence the alarm.
  it("every reason an alert matches is written by the code that writes its event", () => {
    const reasons = constantsOfInfra("ALERT_LOG_REASONS");
    const reasonWriters = { renewalPriceUnavailable: "packages/core/lifecycle/engine.ts" };
    expect(Object.keys(reasons).sort()).toEqual(Object.keys(reasonWriters).sort());
    for (const [key, file] of Object.entries(reasonWriters)) {
      expect(raw(file), `${reasons[key]} in ${file}`).toContain(`reason: "${reasons[key]}"`);
    }
  });

  it("the alerting lines carry severity alert (a person is meant to read them)", () => {
    for (const file of [
      "packages/core/capacity/release.ts",
      "packages/core/invoices/credit-note.ts",
    ]) {
      expect(raw(file)).toMatch(/severity: "alert"/);
    }
  });
});

describe("infra/stacks/alarms.ts", () => {
  it("filters the structured `event` field, not a free-text match", () => {
    expect(alarms).toContain('$.event = "${e}"');
    expect(alarms).toContain('.join(" || ")');
  });

  it("has an alarm for the capacity release, the stuck credit note and the reconciliation", () => {
    for (const id of [
      "CapacityReleaseAlarm",
      "CreditNoteStuckAlarm",
      "FxRateStaleAlarm",
      "RenewalPriceHoldAlarm",
      "ReconcileBadAlarm",
      "ReconcileSilentAlarm",
    ]) {
      expect(alarms, id).toContain(`"${id}"`);
    }
    for (const event of [
      "capacityReleaseProblem",
      "creditNoteStuck",
      "fxRateStaleWarning",
      "lifecycleRenewalHeld",
      "reconcileFindings",
      "reconcileIncomplete",
      "reconcileStaleOperations",
      "reconcileUsageFailed",
      "reconcileOk",
    ]) {
      expect(alarms, event).toContain(`ALERT_LOG_EVENTS.${event}`);
    }
  });

  it("puts the capacity alert on the provisioner and the credit note alert on the scheduler", () => {
    expect(alarms).toMatch(/"CapacityReleaseProblemFilter", provisionerFunction/);
    expect(alarms).toMatch(/"CreditNoteStuckFilter", schedulerFunction/);
    expect(alarms).toMatch(/"FxRateStaleFilter", schedulerFunction/);
    expect(alarms).toMatch(/workers\.provisioner\?\.nodes\.function/);
  });

  // WPU-Z1: a renewal held because it could not be priced for another reason than the rate. The filter is on the
  // scheduler's log group, matches the event AND the reason, and one line in 5 minutes alarms on the alarm topic.
  it("alarms on one renewal held for a price that cannot be had (not the rate), from the scheduler's log", () => {
    const at = alarms.indexOf('new aws.cloudwatch.LogMetricFilter("RenewalPriceHoldFilter"');
    expect(at).toBeGreaterThan(-1);
    const filter = alarms.slice(at, alarms.indexOf("metricTransformation", at));
    // WPU-Z10 (verify review 2026-11-13, B1 alarms.ts:79): the log group comes from the function.
    expect(filter).toContain("logGroupName: logGroupOf(schedulerFunction)");
    // The pattern, with the constants of infra/lib/functions.ts put in, is exactly the one of the task.
    const template = filter.match(/pattern: `([^`]*)`/);
    expect(template).not.toBeNull();
    const events = eventsOfInfra();
    const reasons = constantsOfInfra("ALERT_LOG_REASONS");
    const pattern = template[1]
      .replaceAll("${ALERT_LOG_EVENTS.lifecycleRenewalHeld}", events.lifecycleRenewalHeld)
      .replaceAll("${ALERT_LOG_REASONS.renewalPriceUnavailable}", reasons.renewalPriceUnavailable);
    expect(pattern).toBe(
      '{ $.event = "lifecycle_renewal_held" && $.reason = "price_unavailable" }',
    );
    const transformation = alarms.slice(alarms.indexOf("metricTransformation", at));
    expect(transformation).toMatch(
      /^metricTransformation: \{ name: "RenewalPriceHold", namespace: ALERT_METRIC_NAMESPACE, value: "1", defaultValue: "0", \}/,
    );
    // The alarm is the shared alertAlarm: Sum over 300 seconds, one period, one line or more, to the topic.
    expect(alarms).toMatch(/alertAlarm\( ?"RenewalPriceHoldAlarm", "RenewalPriceHold",/);
    // `code` drops the comments: the helper ends where the next declaration of the file begins.
    const shared = alarms.slice(
      alarms.indexOf("const alertAlarm"),
      alarms.indexOf("const provisionerFunction"),
    );
    expect(shared).toContain("new aws.cloudwatch.MetricAlarm(id,");
    for (const part of [
      'statistic: "Sum"',
      "period: 300",
      "evaluationPeriods: 1",
      "threshold: 1",
      'comparisonOperator: "GreaterThanOrEqualToThreshold"',
      'treatMissingData: "notBreaching"',
      "alarmActions: [topic.arn]",
    ]) {
      expect(shared, part).toContain(part);
    }
    expect(alarms).toMatch(/return \{[^}]*renewalPriceHoldAlarm,/);
  });

  it("alarms on silence: no reconcile run for three hours, missing data breaches", () => {
    const silent = alarms.slice(alarms.indexOf('"ReconcileSilentAlarm"'));
    expect(silent).toMatch(/treatMissingData: "breaching"/);
    expect(silent).toMatch(/evaluationPeriods: RECONCILE_SILENCE_HOURS/);
    expect(functions).toMatch(/RECONCILE_SILENCE_HOURS = 3/);
  });

  it("has an Errors alarm for every scheduled or queued function and the two web servers (5xx)", () => {
    for (const label of [
      "Provisioner",
      "Scheduler",
      "Reconciler",
      "LedgerCheck",
      "PaymentsSweeper",
      "Notifier",
      "CatalogSync",
      "WebServer",
      "AdminServer",
    ]) {
      expect(alarms, label).toContain(`["${label}",`);
    }
    expect(alarms).toContain('namespace: "AWS/Lambda"');
    expect(alarms).toContain('metricName: "Errors"');
    expect(alarms).toContain('comparisonOperator: "GreaterThanOrEqualToThreshold"');
  });

  it("sends every new alarm to the one alarm topic", () => {
    const afterTopic = alarms.slice(alarms.indexOf("const alertFilter"));
    const actions = afterTopic.match(/alarmActions: \[topic\.arn\]/g) ?? [];
    expect(actions.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the wiring", () => {
  it("workers.ts keeps the provisioner subscriber and returns it", () => {
    const workers = code("infra/stacks/workers.ts");
    expect(workers).toMatch(/const provisioner = queues\.provisioning\.subscribe\(/);
    expect(workers).toMatch(
      /return \{ invoked, readerAliases, accessAliases, rendererAliasWeb, crons, provisioner,/,
    );
  });

  // WPU-Y5 (a): the notifier logs notifier_sms_off at the start of a run without the SMS gateway. The metric
  // exists on every stage; only production alarms (staging may run without an SMS contract).
  it("counts notifier_sms_off from the notifier's log and alarms on it in production only", () => {
    expect(alarms).toMatch(
      /alertFilter\( "NotifierSmsOffFilter", notifierFunction, \[ALERT_LOG_EVENTS\.notifierSmsOff\], "NotifierSmsOff", \)/,
    );
    expect(alarms).toContain('const notifierFunction = workers.crons["notifier"]?.nodes.function;');
    expect(alarms).toMatch(
      /stageKind\(stage\) === "production" \? alertAlarm\( "NotifierSmsOffAlarm", "NotifierSmsOff",/,
    );
    expect(alarms).toContain("notifierSmsOffAlarm,");
  });

  it("infra/app.ts hands the web components to the alarms", () => {
    expect(code("infra/app.ts")).toContain("alarms(config, queues, fns, apps)");
  });
});

describe("item 14: the capacity release is worker code", () => {
  it("is no longer exported by the barrel of @tc/core and has its own subpath", () => {
    expect(code("packages/core/capacity/index.ts")).not.toContain("./release");
    expect(raw("packages/core/package.json")).toContain(
      '"./capacity-worker": "./capacity/worker.ts"',
    );
  });

  it("is imported only by worker code: no file of apps/ reaches it", () => {
    let out = "";
    try {
      out = execFileSync(
        "grep",
        ["-rEl", "capacity-worker|capacity/release", "apps", "--include=*.ts", "--include=*.tsx"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch (error) {
      // grep exits 1 when nothing matches: that is the answer we want.
      if (error.status !== 1) throw error;
    }
    expect(out.split("\n").filter((f) => f !== "" && !f.includes("node_modules"))).toEqual([]);
  });
});
