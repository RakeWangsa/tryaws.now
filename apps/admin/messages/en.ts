import type { bn } from "./bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const en: Same<typeof bn> = {
  Admin: {
    meta: {
      title: "TiCON Cloud Admin",
    },
    home: {
      title: "The admin panel is being built",
      body: "This page holds the frame only for now.",
    },
  },
};
