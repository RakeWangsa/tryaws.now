import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// WPU-X23: every notice of an action that can answer "fresh_sign_in_required" (6.1) carries the
// "Sign in again" link (FreshSignInLink, built with reauthHref). The files are those whose actions
// call requireFreshSignIn or run a destructive frame.
const PANEL = join(import.meta.dirname, "..", "app", "[locale]", "(panel)");
const FILES = [
  "_console/ConsoleForms.tsx",
  "_family/AutoRenewSwitch.tsx",
  "_family/FamilyForms.tsx",
  "cdn/[id]/CdnForms.tsx",
  "containers/[id]/ContainerForms.tsx",
  "databases/[id]/DatabaseAccess.tsx",
  "databases/[id]/DatabaseBackups.tsx",
  "dns/[id]/RecordForms.tsx",
  "servers/[id]/ExtrasForms.tsx",
  "servers/[id]/WindowsAccess.tsx",
  "settings/ssh-keys/KeyForms.tsx",
  "storage/[id]/BucketKeys.tsx",
  "storage/[id]/StorageForms.tsx",
];

describe("the Sign in again link", () => {
  it.each(FILES)("%s offers it", (file) => {
    const source = readFileSync(join(PANEL, file), "utf8");
    expect(source).toContain("<FreshSignInLink");
  });
});
