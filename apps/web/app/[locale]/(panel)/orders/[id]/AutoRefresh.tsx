"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 16.11 step 6: the page refreshes every few seconds until the operation is over. It holds no data;
 * a refresh only asks the server for the same page again, so a failed refresh changes nothing.
 */
export function AutoRefresh({ active, everyMs = 5000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return null;
}
