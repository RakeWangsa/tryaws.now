// WPU-Y3b. Two small pure rules of the unpaid-usage rule that the engine and renewNow share.

interface ResourceFacts {
  readonly resource: {
    readonly state: string;
    readonly config: Readonly<Record<string, unknown>>;
  };
}

/**
 * Finding 2. A renewal from grace resumes a suspended resource, except (a) one an admin suspended
 * (section 11) and (b) one whose unpaid usage charge is still open (`config.unpaidSince`): that
 * resource is resumed by the unpaid job once the charge is paid, and only then. A resume here would
 * hand a customer who paid the renewal but not the usage a running resource.
 */
export function resumeAfterRenewalAllowed(row: ResourceFacts): boolean {
  const { state, config } = row.resource;
  if (state !== "suspended") return false;
  if (config.adminSuspended === true) return false;
  const mark = config.unpaidSince;
  return mark === undefined || mark === null;
}

/**
 * Finding 7. The destroy and final-snapshot operations of the retention have one key for each period.
 * A row of that key that is dead (failed) or done (succeeded, an earlier retention that a restore
 * ended) must not be handed back to a new unpaid episode of the same period: that episode takes a key
 * with its own start. A live row (queued, running, waiting, waiting for approval or attention) is
 * the same retention: its key is kept, so the engine's own pass and the job share one operation.
 */
export function retentionKeyNeedsSalt(storedState: string): boolean {
  return storedState === "failed" || storedState === "succeeded";
}
