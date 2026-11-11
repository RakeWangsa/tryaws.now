import { requirePanel } from "./panel.ts";
import type { PanelData } from "./panel.ts";
import { getRuntime } from "./runtime.ts";

/**
 * The first line of the pages of the servers, orders and settings screens: the runtime is started
 * first (it configures sign-in and builds the services, once), then the panel data or the login
 * redirect (R16). A runtime that cannot start is an error page, never a page without a check.
 */
export async function startPanelPage(path: string): Promise<PanelData> {
  await getRuntime();
  return requirePanel(path);
}
