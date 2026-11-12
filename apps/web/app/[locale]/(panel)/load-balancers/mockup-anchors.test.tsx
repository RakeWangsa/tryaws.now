import { vi } from "vitest";
import { defineAnchorSuite } from "../_family/anchor-suite.tsx";
import { LOAD_BALANCER_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

defineAnchorSuite({
  title: "the load balancer screens follow the shared mockup",
  anchors: LOAD_BALANCER_ANCHORS,
  renderers: STATE_RENDERERS,
  screens: ["lb", "lb_new", "lb_detail"],
  required: [
    "lb.empty",
    "lb.flag_off",
    "lb_new.flag_off",
    "lb_new.kyc_required",
    "lb_new.no_servers",
    "lb_detail.not_found",
  ],
});
