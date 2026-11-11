// Which shell demos each app serves. The customer app never serves the admin demo and the admin app
// never serves the customer ones (R10: they are separate apps).

export const GALLERY_SHELLS = {
  web: ["public", "auth", "app"],
  admin: ["admin"],
} as const satisfies Readonly<Record<"web" | "admin", readonly string[]>>;

export type GalleryShell = "public" | "auth" | "app" | "admin";

/** The shell named by `value` if this app serves it, else null. */
export function resolveGalleryShell(app: "web" | "admin", value: string): GalleryShell | null {
  for (const shell of GALLERY_SHELLS[app]) {
    if (shell === value) return shell;
  }
  return null;
}
