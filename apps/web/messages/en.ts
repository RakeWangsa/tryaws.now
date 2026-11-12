import type { bn } from "./bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const en: Same<typeof bn> = {
  Web: {
    meta: {
      title: "MeghVPS",
      description:
        "Prepaid cloud panel for Bangladesh. 100% AWS infrastructure. Built on Amazon Lightsail.",
    },
    announcement: "MeghVPS is coming soon.",
    home: {
      title: "MeghVPS is coming soon.",
    },
  },
};
