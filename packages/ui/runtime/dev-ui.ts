// Whether the `/dev/ui` gallery may be served (16.16). The production stage never serves it.

export function isDevUiEnabled(env: {
  NODE_ENV?: string;
  TC_DEV_UI?: string;
  TC_STAGE?: string;
}): boolean {
  if (env.TC_STAGE === "production") return false;
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return true;
  return env.TC_DEV_UI === "on";
}
