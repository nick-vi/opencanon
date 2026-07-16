import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import {
  ProtocolHeader,
  ProtocolHttpMethod,
  ProtocolRoute,
} from "@opencanon/core";
import { runtimeAuthHeaders } from "../src/auth.ts";
import { LocalTransportKind, localPipeEndpoint, pipeProtocolTransport, serveLocalProtocolPipe } from "../src/local-protocol.ts";
import { createRuntimeProtocolPolicy } from "../src/protocol-policy.ts";
import { json } from "../src/routes.ts";
import { serveRuntime } from "../src/server-http.ts";

const TestToken = "protocol-policy-token";

test("protocol policy rejects unknown, unauthorized, unversioned, and invalid requests before handlers run", async () => {
  const policy = createRuntimeProtocolPolicy({ authToken: TestToken, currentRevision: () => 1 });
  let handled = 0;
  const handler = async () => {
    handled += 1;
    return json({ ok: true, data: {} });
  };

  assert.equal((await policy.execute(new Request("http://opencanon.runtime/api/missing"), handler)).status, 404);
  assert.equal((await policy.execute(new Request(`http://opencanon.runtime${ProtocolRoute.ProjectSummary}`), handler)).status, 401);
  assert.equal((await policy.execute(new Request(`http://opencanon.runtime${ProtocolRoute.ProjectSummary}`, {
    headers: { authorization: `Bearer ${TestToken}` },
  }), handler)).status, 400);
  assert.equal((await policy.execute(new Request(`http://opencanon.runtime${ProtocolRoute.Settings}`, {
    method: ProtocolHttpMethod.Post,
    headers: { ...runtimeAuthHeaders(TestToken), "content-type": "application/json" },
    body: "{",
  }), handler)).status, 400);
  assert.equal(handled, 0);
});

test("keyed commands require an explicit idempotency key", async () => {
  const policy = createRuntimeProtocolPolicy({ authToken: TestToken, currentRevision: () => 1 });
  const handler = async () => json({ ok: true, data: { recorded: true } });
  const request = (key?: string) => new Request(`http://opencanon.runtime${ProtocolRoute.ChangeEvents}`, {
    method: ProtocolHttpMethod.Post,
    headers: {
      ...runtimeAuthHeaders(TestToken),
      "content-type": "application/json",
      ...(key ? { [ProtocolHeader.IdempotencyKey]: key } : {}),
    },
    body: JSON.stringify({ changeId: "change", type: "started" }),
  });

  assert.equal((await policy.execute(request(), handler)).status, 400);
  assert.equal((await policy.execute(request("event-1"), handler)).status, 200);
});

test("published queries retry against one stable revision and fail on repeated churn", async () => {
  let revision = 1;
  let attempts = 0;
  const policy = createRuntimeProtocolPolicy({ authToken: TestToken, currentRevision: () => revision });
  const request = () => new Request(`http://opencanon.runtime${ProtocolRoute.ContextSearch}?query=policy`, {
    headers: runtimeAuthHeaders(TestToken),
  });
  const stabilized = await policy.execute(request(), async () => {
    attempts += 1;
    if (attempts === 1) revision += 1;
    return json({ ok: true, data: { results: [] } });
  });
  assert.equal(stabilized.status, 200);
  assert.equal(attempts, 2);
  assert.equal((await stabilized.json() as { data: { revision: number } }).data.revision, 2);

  const conflicted = await policy.execute(request(), async () => {
    revision += 1;
    return json({ ok: true, data: { results: [] } });
  });
  assert.equal(conflicted.status, 409);
});

test("operation capacity is shared across HTTP and pipe until response delivery completes", async () => {
  const endpoint = localPipeEndpoint({ scope: "runtime", key: `protocol-policy:${randomUUID()}` });
  const policy = createRuntimeProtocolPolicy({ authToken: TestToken, currentRevision: () => 1 });
  const releaseRoutes: Array<() => void> = [];
  let entered = 0;
  let signalEntered!: () => void;
  const routesEntered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const handler = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== ProtocolRoute.ContextSearch) {
      return json({ ok: true, data: { status: "ok" } });
    }
    const released = new Promise<void>((resolve) => releaseRoutes.push(resolve));
    entered += 1;
    if (entered === 2) signalEntered();
    await released;
    return json({ ok: true, data: { results: [] } });
  };
  const routeRequest = (request: Request) => policy.execute(request, handler);
  const http = await serveRuntime({
    host: "127.0.0.1",
    port: 0,
    preflightRequest: policy.preflight,
    routeRequest,
    requestBodyLimit: policy.requestBodyLimit,
  });
  const pipe = await serveLocalProtocolPipe({
    endpoint,
    preflightRequest: policy.preflight,
    routeRequest,
    requestBodyLimit: policy.requestBodyLimit,
  });
  try {
    const url = `${ProtocolRoute.ContextSearch}?query=policy`;
    const activeHttp = fetch(`http://127.0.0.1:${http.port}${url}`, { headers: runtimeAuthHeaders(TestToken) });
    const activePipe = pipeProtocolTransport.request(
      { transport: LocalTransportKind.Pipe, pipeEndpoint: endpoint, authToken: TestToken },
      { method: ProtocolHttpMethod.Get, path: url },
    );
    await routesEntered;

    const rejected = await pipeProtocolTransport.request(
      { transport: LocalTransportKind.Pipe, pipeEndpoint: endpoint, authToken: TestToken },
      { method: ProtocolHttpMethod.Get, path: url },
    );
    assert.equal(rejected.status, 503);
    assert.equal((rejected.body as { error?: { diagnostics?: Array<{ code?: string }> } }).error?.diagnostics?.[0]?.code, "operation-capacity-exceeded");

    for (const release of releaseRoutes) release();
    assert.equal((await activeHttp).status, 200);
    assert.equal((await activePipe).status, 200);
  } finally {
    for (const release of releaseRoutes) release();
    await Promise.allSettled([http.stop(true), pipe.stop(true)]);
  }
});

test("operation policy rejects declared request overflow and invalid handler output", async () => {
  const policy = createRuntimeProtocolPolicy({ authToken: TestToken, currentRevision: () => 1 });
  const oversized = new Request(`http://opencanon.runtime${ProtocolRoute.Settings}`, {
    method: ProtocolHttpMethod.Post,
    headers: {
      ...runtimeAuthHeaders(TestToken),
      "content-length": String(policy.requestBodyLimit(ProtocolHttpMethod.Post, ProtocolRoute.Settings) + 1),
    },
  });
  assert.equal((await policy.execute(oversized, async () => json({ ok: true, data: {} }))).status, 413);

  const invalidOutput = await policy.execute(
    new Request(`http://opencanon.runtime${ProtocolRoute.State}`, { headers: runtimeAuthHeaders(TestToken) }),
    async () => json({ ok: true, data: { invalid: true } }),
  );
  assert.equal(invalidOutput.status, 500);
});
