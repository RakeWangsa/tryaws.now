import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handleReturnRequest: vi.fn(),
  handleHeadRequest: vi.fn(),
}));

vi.mock("./handle.ts", () => state);

import * as cancel from "./cancel/route.ts";
import * as fail from "./fail/route.ts";
import * as success from "./success/route.ts";

const ROUTES = { success, fail, cancel } as const;

beforeEach(() => {
  state.handleReturnRequest.mockReset();
  state.handleReturnRequest.mockResolvedValue(new Response(null, { status: 303 }));
  state.handleHeadRequest.mockReset();
  state.handleHeadRequest.mockReturnValue(new Response(null, { status: 405 }));
});

describe.each(Object.entries(ROUTES))("/pay/eps/%s", (outcome, route) => {
  it("is dynamic: never prerendered, never cached", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("exports GET and HEAD and no state-changing method", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "HEAD", "dynamic"]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(method in route, method).toBe(false);
    }
  });

  it("GET hands the request and its outcome to the handler and returns its answer", async () => {
    const request = new Request(`https://cloud.example.com/pay/eps/${outcome}`);
    const response = await route.GET(request);
    expect(state.handleReturnRequest).toHaveBeenCalledTimes(1);
    expect(state.handleReturnRequest).toHaveBeenCalledWith(request, outcome);
    expect(response.status).toBe(303);
  });

  it("HEAD does not run the handler of the return (Next would run GET for it otherwise)", async () => {
    const response = await route.HEAD();
    expect(response.status).toBe(405);
    expect(state.handleReturnRequest).not.toHaveBeenCalled();
  });
});
