import type { Locale, Messages } from "../../runtime/index.ts";
import { bn } from "./bn.ts";
import { en } from "./en.ts";

// Namespace `Gallery`, the only top-level key, so it cannot clash with kit, Shell, Aws, Web or Admin.
export const galleryMessages: Readonly<Record<Locale, Messages>> = { bn, en };
