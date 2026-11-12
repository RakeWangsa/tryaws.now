import { useTranslations } from "next-intl";
import type { DatabaseSpecs } from "../../../../server/databases-view.ts";

// Small pieces the database screens share. Synchronous, so they render in a test without a request.

/** "MySQL 8.0"; the engine word alone when there is no version; null when the catalog names none. */
export function useEngineLabel(): (
  specs: Pick<DatabaseSpecs, "engine" | "version">,
) => string | null {
  const t = useTranslations("Databases.engine");
  return (specs) => {
    if (specs.engine === undefined) return null;
    const name = t.has(specs.engine) ? t(specs.engine) : specs.engine;
    return specs.version === undefined ? name : `${name} ${specs.version}`;
  };
}
