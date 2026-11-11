// Proof of WP1-T4, second half: "preview equals engine output" (section 8), against the database.
// The unit half is packages/core/pricing/preview.test.ts: each preview row equals quote().
import { LAUNCH_PRICING_STEPS, seedLaunchData, type AdminActor } from "@tc/db";
import { useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { PREVIEW_SAMPLES, type PricingStep } from "../pricing/index";
import { previewChange, quoteInForce, savePricingRule, setFxRate } from "./index";
import { adminActor, asOwner, asRole, clockAt } from "../test/rates-support";

const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const T1 = new Date("2026-11-12T06:00:00.000Z");
const clock = (d: Date) => clockAt(d.toISOString());
const markup: PricingStep[] = LAUNCH_PRICING_STEPS.map((s) => ({
  ...s,
  label: { ...s.label },
  rate: s.code === "markup" ? "0.03" : s.rate,
}));

let actor: AdminActor;
beforeAll(async () => {
  actor = await adminActor(t, "finance");
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: T0 }));
});

it("the five products that the preview shows before the save are the five that the engine charges after it", async () => {
  const preview = await asRole(t, "admin_rw", (tx) =>
    previewChange(
      tx,
      { market: "BD", productFamily: null, fxRate: "130", steps: markup },
      clock(T1),
    ),
  );
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.rows).toHaveLength(5);

  const fx = await asRole(t, "admin_rw", (tx) =>
    setFxRate(tx, actor, { market: "BD", rate: "130", reason: "weekly rate" }, clock(T1)),
  );
  const rule = await asRole(t, "admin_rw", (tx) =>
    savePricingRule(
      tx,
      actor,
      { market: "BD", productFamily: null, steps: markup, reason: "service charge" },
      clock(T1),
    ),
  );
  expect(fx.ok && rule.ok).toBe(true);
  const ruleId = rule.ok ? rule.value.ruleId : "";

  for (const [i, sample] of PREVIEW_SAMPLES.entries()) {
    const priced = await asRole(t, "web_rw", (tx) =>
      quoteInForce(
        tx,
        {
          market: "BD",
          productFamily: null,
          awsPriceUsd: sample.awsPriceUsd,
          quantity: sample.quantity,
        },
        clock(T1),
      ),
    );
    expect(priced.ok, sample.id).toBe(true);
    // the preview cannot know the version of a rule that has no id yet; every other field is equal
    expect(priced.ok && priced.value.quote, sample.id).toEqual({
      ...preview.value.rows[i]!.candidate,
      ruleVersion: ruleId,
    });
  }
  expect(preview.value.rows.map((r) => r.candidate.totalMinor)).toEqual([
    78000n,
    374400n,
    1310400n,
    124800n,
    26n,
  ]);
});
