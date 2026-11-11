import type { ReactNode } from "react";

/**
 * The route group of the signed-in panel. Each page starts with `requirePanel(path)` (a redirect to
 * `/login?next=…` without a session, R16) and wraps its content in `PanelFrame`, because only the
 * page knows its own navigation entry. The `X-Robots-Tag: noindex` header of these paths is set in
 * next.config.ts. WP2-T2, WP4-T7 and WP5-T6 add their pages in this group and reuse both.
 */
export default function PanelLayout({ children }: { children: ReactNode }) {
  return children;
}
