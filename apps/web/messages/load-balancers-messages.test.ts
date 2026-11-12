import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { loadBalancersBn } from "./load-balancers-bn.ts";
import { loadBalancersEn } from "./load-balancers-en.ts";

describe("load balancer screen messages (WP6-T3)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(loadBalancersBn)).toEqual(messageKeys(loadBalancersEn));
    expect(messageKeys(loadBalancersBn).length).toBeGreaterThan(90);
    for (const tree of [loadBalancersBn, loadBalancersEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("is composed in both locales in its own namespace, with bn text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["LoadBalancers"], locale).toBeDefined();
    }
    expect((webMessages.bn["LoadBalancers"] as Messages)["heading"] as string).toMatch(/[ঀ-৿]/);
  });

  it("names Amazon Lightsail the exact way and shows no account id or ARN (U6, 16.13)", () => {
    for (const tree of [loadBalancersBn, loadBalancersEn]) {
      const text = JSON.stringify(tree);
      expect(text).toContain("Amazon Lightsail load balancer");
      expect(text).not.toMatch(/arn:aws|\b\d{12}\b|AWS Lightsail/);
    }
  });

  it("every action error key of the cores has a text (U6)", () => {
    for (const key of [
      "unauthenticated",
      "fresh_sign_in_required",
      "flag_off",
      "validation",
      "rate_limited",
      "not_found",
      "name_mismatch",
      "not_allowed",
      "unavailable",
    ]) {
      expect(loadBalancersEn.LoadBalancers.error, key).toHaveProperty(key);
    }
    for (const key of ["targetsQueued", "destroyQueued", "approval"]) {
      expect(loadBalancersEn.LoadBalancers.done, key).toHaveProperty(key);
    }
  });
});
