import type { bn } from "./bn.ts";

type Same<T> = { [K in keyof T]: T[K] extends string ? string : Same<T[K]> };

export const en: Same<typeof bn> = {
  Web: {
    meta: {
      title: "TryAWS.now",
      description:
        "Prepaid cloud panel for Bangladesh. 100% AWS infrastructure. Built on Amazon Lightsail.",
    },
    announcement: "TryAWS.now is coming soon.",
    home: {
      title: "TryAWS.now is coming soon.",
    },
  },
};
