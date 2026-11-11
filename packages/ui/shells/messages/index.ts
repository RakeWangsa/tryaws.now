import type { Locale, Messages } from "../runtime-local.ts";
import { bn } from "./bn.ts";
import { en } from "./en.ts";

export const shellMessages: Readonly<Record<Locale, Messages>> = { bn, en };
