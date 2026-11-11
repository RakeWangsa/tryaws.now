// The configuration of apps/web, parsed from the environment that is passed in (never read here).
// Fail closed (R16): anything unclear throws, and the text is fixed: a rejected value may be a
// mistyped secret and must not reach a log (R3, R14).

export type Stage = "local" | "test" | "staging" | "production";

export interface WebConfig {
  stage: Stage;
  /** A plain origin, no path, no final slash: the only host a redirect or a form may name. */
  appOrigin: string;
  epsMode: "sandbox" | "production";
  /** The fake EPS and the dev sign-in. True only in stage local or test in development or test. */
  fakes: boolean;
}

export class WebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebConfigError";
  }
}

const STAGES: readonly Stage[] = ["local", "test", "staging", "production"];

function parseStage(raw: string | undefined): Stage {
  const found = STAGES.find((stage) => stage === raw);
  if (found === undefined) throw new WebConfigError("web config: TC_STAGE is missing or unknown");
  return found;
}

function parseOrigin(raw: string | undefined, stage: Stage): string {
  const fail = () => new WebConfigError("web config: APP_ORIGIN is missing or not a plain origin");
  if (typeof raw !== "string" || raw.length === 0) throw fail();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail();
  }
  const plain =
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/" &&
    (raw === url.origin || raw === `${url.origin}/`);
  if (!plain) throw fail();
  if (url.protocol === "https:") return url.origin;
  const localOnly = stage === "local" || stage === "test";
  if (url.protocol === "http:" && localOnly && url.hostname === "localhost" && url.port !== "") {
    return url.origin;
  }
  throw fail();
}

export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const stage = parseStage(env["TC_STAGE"]);
  const appOrigin = parseOrigin(env["APP_ORIGIN"], stage);

  const eps = env["TC_EPS"];
  let fakes = false;
  if (eps !== undefined && eps !== "") {
    // Two guards: the stage, and NODE_ENV (`next start` and every deployed build run as production).
    // The third is the constructor of the in-memory EPS, which throws outside development and test.
    const nodeEnv = env["NODE_ENV"];
    const allowed =
      eps === "fake" &&
      (stage === "local" || stage === "test") &&
      (nodeEnv === "development" || nodeEnv === "test");
    if (!allowed) throw new WebConfigError("web config: TC_EPS is refused here");
    fakes = true;
  }

  return { stage, appOrigin, epsMode: stage === "production" ? "production" : "sandbox", fakes };
}
