import type { bn } from "./bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const en: Same<typeof bn> = {
  Web: {
    meta: {
      title: "TiCON Cloud",
      description:
        "Prepaid cloud panel for Bangladesh. 100% AWS infrastructure. Built on Amazon Lightsail.",
    },
    announcement: "TiCON Cloud is coming soon.",
    home: {
      title: "TiCON Cloud is coming soon.",
    },
  },
};
