import type { PoolConfig } from "../config";

// One JSON answer per documented Cognito shape. Nothing here is a real token or a real pool.
export const POOL: PoolConfig = {
  region: "eu-west-1",
  userPoolId: "eu-west-1_Abc123Xyz",
  clientId: "abcdefghij1234567890",
};

export const PLANTED = {
  password: "P1anted-Passw0rd!x",
  code: "987654",
  accessToken: "planted.access.token",
  refreshToken: "planted.refresh.token",
  session: "PLANTED-COGNITO-SESSION-STRING",
  email: "planted.person@example.test",
} as const;

export const json = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  });

// Cognito writes the type bare or as "<namespace>#Name"; both forms are used on purpose.
export const cognitoError = (type: string, status = 400): Response =>
  json(status, { __type: type, message: `text that holds ${PLANTED.password}` });

export const emptyOk = (): Response => json(200, {});

export const signUpOk = (sub = "11111111-2222-3333-4444-555555555555"): Response =>
  json(200, {
    UserConfirmed: false,
    UserSub: sub,
    CodeDeliveryDetails: { Destination: "r***@e***" },
  });

export const tokens = (over: Record<string, unknown> = {}): Response =>
  json(200, {
    AuthenticationResult: {
      AccessToken: PLANTED.accessToken,
      RefreshToken: PLANTED.refreshToken,
      IdToken: "planted.id.token",
      ExpiresIn: 3600,
      TokenType: "Bearer",
      ...over,
    },
  });

export const challenge = (name: string): Response =>
  json(200, { ChallengeName: name, Session: PLANTED.session, ChallengeParameters: {} });

export interface RecordedCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
  readonly hasSignal: boolean;
}

export function recording(answer: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: unknown, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "");
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    return Promise.resolve(answer());
  }) as typeof fetch;
  return { fetchImpl, calls };
}
