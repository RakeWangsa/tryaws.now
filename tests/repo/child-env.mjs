// Inside a git hook these variables point git at the real repository. The child processes of
// these tests never get them, so the test repositories stay the only ones they touch.
export const GIT_REPO_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
];

export function childEnv(env = {}) {
  const result = { ...process.env, ...env };
  for (const name of GIT_REPO_VARS) delete result[name];
  return result;
}
