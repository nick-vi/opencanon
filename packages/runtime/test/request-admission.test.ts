import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { LocalTransportKind, localPipeEndpoint, pipeProtocolTransport, serveLocalProtocolPipe } from "../src/local-protocol.ts";
import { runtimeAuthHeaders } from "../src/auth.ts";
import { createRuntimeRequestAdmission } from "../src/request-admission.ts";
import { json } from "../src/routes.ts";
import { serveRuntime } from "../src/server-http.ts";

test("full snapshot admission is shared across HTTP and pipe until delivery completes", async () => {
  const pipeEndpoint = localPipeEndpoint({ scope: "runtime", key: `request-admission:${randomUUID()}` });
  const authToken = randomUUID();
  const admission = createRuntimeRequestAdmission({ authToken });
  let releaseRoute!: () => void;
  let signalEntered!: () => void;
  const routeReleased = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const routeEntered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let blockNextSnapshot = true;
  const routeRequest = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/snapshot" && blockNextSnapshot) {
      blockNextSnapshot = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true,"data":'));
          signalEntered();
          void routeReleased.then(() => {
            controller.enqueue(new TextEncoder().encode('{"path":"/api/snapshot"}}'));
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return json({ ok: true, data: { path: new URL(request.url).pathname } });
  };

  const http = await serveRuntime({ host: "127.0.0.1", port: 0, routeRequest, requestAdmission: admission });
  const pipe = await serveLocalProtocolPipe({ endpoint: pipeEndpoint, routeRequest, requestAdmission: admission });
  try {
    const activeHttpRequest = fetch(`http://127.0.0.1:${http.port}/api/snapshot`, { headers: runtimeAuthHeaders(authToken) });
    await routeEntered;

    const rejectedPipeRequest = await pipeProtocolTransport.request(
      { transport: LocalTransportKind.Pipe, pipeEndpoint, authToken },
      { method: "GET", path: "/api/snapshot" },
    );
    assert.equal(rejectedPipeRequest.status, 429);
    assert.equal((rejectedPipeRequest.body as { error?: { diagnostics?: Array<{ code?: string }> } }).error?.diagnostics?.[0]?.code, "request-capacity-exceeded");

    const health = await pipeProtocolTransport.request(
      { transport: LocalTransportKind.Pipe, pipeEndpoint, authToken },
      { method: "GET", path: "/api/health" },
    );
    assert.equal(health.status, 200, "bounded routes remain available while a snapshot response is active");

    releaseRoute();
    const completedHttpResponse = await activeHttpRequest;
    assert.equal(completedHttpResponse.status, 200);
    assert.deepEqual(await completedHttpResponse.json(), { ok: true, data: { path: "/api/snapshot" } });

    const admittedAfterRelease = await pipeProtocolTransport.request(
      { transport: LocalTransportKind.Pipe, pipeEndpoint, authToken },
      { method: "GET", path: "/api/snapshot" },
    );
    assert.equal(admittedAfterRelease.status, 200);
  } finally {
    await Promise.allSettled([http.stop(true), pipe.stop(true)]);
  }
});

test("full snapshot admission rejects invalid capacity and release is idempotent", () => {
  assert.throws(() => createRuntimeRequestAdmission({ capacity: 0 }), /positive integer/);
  const admission = createRuntimeRequestAdmission();
  const request = new Request("http://opencanon.runtime/api/snapshot");
  const first = admission.admit(request);
  assert.equal(first.ok, true);
  assert.equal(admission.admit(request).ok, false);
  if (first.ok) {
    first.release();
    first.release();
  }
  assert.equal(admission.admit(request).ok, true);
});

test("unauthorized snapshot requests do not consume authenticated capacity", () => {
  const authToken = "test-runtime-token";
  const admission = createRuntimeRequestAdmission({ authToken });
  const unauthorized = admission.admit(new Request("http://opencanon.runtime/api/snapshot"));
  assert.equal(unauthorized.ok, true);
  const authorized = admission.admit(new Request("http://opencanon.runtime/api/snapshot", { headers: runtimeAuthHeaders(authToken) }));
  assert.equal(authorized.ok, true);
  if (authorized.ok) authorized.release();
  if (unauthorized.ok) unauthorized.release();
});
