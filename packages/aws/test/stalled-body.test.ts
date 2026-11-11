import http from "node:http";
import { Duplex } from "node:stream";
import { CreateInstancesCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { afterEach, expect, it, vi } from "vitest";
import { mapErrors } from "../errors";
import { REQUEST_TIMEOUT_MS, TIME_LIMITS, clientSettings } from "../settings";

// The REAL NodeHttpHandler of the SDK talks to an in-memory socket: no TCP, no network.
class MemSocket extends Duplex {
  peer: MemSocket | undefined;
  connecting = false;
  remoteAddress = "127.0.0.1";
  remotePort = 1;
  idleMs = 0;
  idleTimer: NodeJS.Timeout | undefined;
  constructor() {
    super({ allowHalfOpen: false });
  }
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleMs > 0 && !this.destroyed) {
      this.idleTimer = setTimeout(() => this.emit("timeout"), this.idleMs);
    }
  }
  _read() {}
  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void) {
    this.touch();
    if (this.peer && !this.peer.destroyed) {
      this.peer.touch();
      this.peer.push(chunk);
    }
    cb();
  }
  _final(cb: () => void) {
    this.peer?.push(null);
    cb();
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const p = this.peer;
    this.peer = undefined;
    if (p && !p.destroyed) setImmediate(() => p.destroy());
    cb(err);
  }
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.once("timeout", cb);
    this.idleMs = ms;
    this.touch();
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  address() {
    return { address: "127.0.0.1", family: "IPv4", port: 2 };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

/** A server that sends the response headers and then nothing: the body stalls. */
function stalledBodyClient(requestHandler: object) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.flushHeaders();
    });
  });
  const agent = new http.Agent({ keepAlive: true });
  (agent as unknown as { createConnection: unknown }).createConnection = () => {
    const client = new MemSocket();
    const serverSide = new MemSocket();
    client.peer = serverSide;
    serverSide.peer = client;
    server.emit("connection", serverSide);
    return client;
  };
  const settings = clientSettings("TcProvisioner");
  const client = new LightsailClient({
    region: "ap-southeast-1",
    endpoint: "http://127.0.0.1:1",
    credentials: async () => ({
      accessKeyId: "tc-test-key",
      secretAccessKey: "tc-test-secret",
      sessionToken: "tc-test-token",
      expiration: new Date(Date.now() + 3_600_000),
    }),
    maxAttempts: settings.maxAttempts,
    ...("retryStrategy" in settings ? { retryStrategy: settings.retryStrategy } : {}),
    requestHandler: { ...requestHandler, httpAgent: agent },
  });
  mapErrors(client);
  return { client, agent };
}

/** The outcome of a promise after the event loop has had several turns (setImmediate is real). */
async function turns(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((r) => setImmediate(r));
}

/** Fake time in small steps, so the request is sent and the headers arrive before the limits. */
async function elapse(totalMs: number): Promise<void> {
  for (let spent = 0; spent < totalMs; spent += 100) {
    await vi.advanceTimersByTimeAsync(100);
    await turns();
  }
}

async function settled(pending: Promise<unknown>): Promise<unknown> {
  await turns();
  return Promise.race([pending, Promise.resolve("STILL PENDING")]);
}

const create = () =>
  new CreateInstancesCommand({
    instanceNames: ["tc-instance-9766a84e943a8987"],
    availabilityZone: "ap-southeast-1a",
    blueprintId: "ubuntu_24_04",
    bundleId: "nano_3_0",
  });

it("the socket time-out is the request time-out, so a stalled body ends a mutating call (W30)", () => {
  expect(TIME_LIMITS.socketTimeout).toBe(REQUEST_TIMEOUT_MS);
  expect(clientSettings("TcProvisioner").requestHandler.socketTimeout).toBe(15_000);
  expect(clientSettings("sts").requestHandler.socketTimeout).toBe(15_000);
});

it("a response whose body stalls after the headers ends with an AwsError that may have acted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { client, agent } = stalledBodyClient(clientSettings("TcProvisioner").requestHandler);
  const pending = client.send(create()).then(
    () => "RESOLVED",
    (error: unknown) => error,
  );
  // past the request time-out (it ended when the headers arrived) and the socket time-out
  await elapse(REQUEST_TIMEOUT_MS + 5_000);
  const outcome = await settled(pending);
  agent.destroy();
  expect(outcome).toMatchObject({
    name: "AwsError",
    code: "upstream_unavailable",
    operation: "CreateInstances",
    mayHaveActed: true,
  });
});

it("control: without the socket time-out the same stalled body never ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { socketTimeout: _removed, ...withoutSocketTimeout } = TIME_LIMITS;
  const { client, agent } = stalledBodyClient(withoutSocketTimeout);
  const pending = client.send(create()).then(
    () => "RESOLVED",
    (error: unknown) => error,
  );
  await elapse(REQUEST_TIMEOUT_MS + 5_000);
  const outcome = await settled(pending);
  agent.destroy();
  expect(outcome).toBe("STILL PENDING");
});
