// The configuration of apps/web, parsed from the environment that is passed in (never read here).
// Fail closed (R16): anything unclear throws, and the text is fixed: a rejected value may be a
// mistyped secret and must not reach a log (R3, R14).

export type Stage = "local" | "test" | "staging" | "production";

export interface WebConfig {
  stage: Stage;
  /** A plain origin, no path, no final slash: the only host a redirect or a form may name. */
  appOrigin: string;
  epsMode: "sandbox" | "production";
  /** Any fake in use: the dev sign-in and a loopback client address. True only in stage local or test in development or test. */
  fakes: boolean;
  /** Which fakes: the in-memory EPS, identity provider and SMS gateway. Same guards as `fakes`. */
  fake: FakeSwitches;
}

export interface FakeSwitches {
  eps: boolean;
  idp: boolean;
  sms: boolean;
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

  // Two guards: the stage, and NODE_ENV (`next start` and every deployed build run as production).
  // The third is the constructor of each in-memory service, which throws outside development and test.
  const nodeEnv = env["NODE_ENV"];
  const fakeAllowed =
    (stage === "local" || stage === "test") && (nodeEnv === "development" || nodeEnv === "test");
  const switchOn = (name: "TC_EPS" | "TC_IDP" | "TC_SMS"): boolean => {
    const value = env[name];
    if (value === undefined || value === "") return false;
    if (value !== "fake" || !fakeAllowed) {
      throw new WebConfigError(`web config: ${name} is refused here`);
    }
    return true;
  };
  const fake: FakeSwitches = {
    eps: switchOn("TC_EPS"),
    idp: switchOn("TC_IDP"),
    sms: switchOn("TC_SMS"),
  };
  const fakes = fake.eps || fake.idp || fake.sms;

  return {
    stage,
    appOrigin,
    epsMode: stage === "production" ? "production" : "sandbox",
    fakes,
    fake,
  };
}
