import { vi } from "vitest";
import { defineAnchorSuite } from "../_family/anchor-suite.tsx";
import { DATABASE_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

defineAnchorSuite({
  title: "the database screens follow the shared mockup",
  anchors: DATABASE_ANCHORS,
  renderers: STATE_RENDERERS,
  screens: ["databases", "databases_new", "databases_detail"],
  required: [
    "databases.empty",
    "databases.flag_off",
    "databases_new.flag_off",
    "databases_new.kyc_required",
    "databases_detail.not_found",
  ],
});
