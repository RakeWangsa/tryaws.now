import { v7 as uuidv7 } from "uuid";

/**
 * A new UUID version 7 (time-ordered). The apps use this and do not depend on `uuid` themselves:
 * ids of payments and the like are made here so that rows sort by creation.
 */
export function newUuidV7(): string {
  return uuidv7();
}
