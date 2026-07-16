import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import {
  DomainProtocolVersion,
  ProjectProtocolEventSchema,
  ProjectionResponseSchema,
  ProtocolAuthorization,
  ProtocolHeader,
  ProtocolHttpMethod,
  ProtocolOperationMetadataSchema,
  ProtocolOperations,
  ProtocolResponseFailure,
  ProtocolRoute,
  ProtocolTransportFailure,
  ProtocolTransportFailureCode,
  createDomainProtocolClient,
  createOpenCanonOpenApiDocument,
  createOpenCanonProblem,
  createOpenCanonProblemFailure,
  OpenCanonProblemCode,
  OpenCanonProblemSource,
  findProtocolOperation,
  operationMetadata,
  protocolMethodsForPath,
  protocolOperationById,
} from "@opencanon/core";

test("the protocol registry owns every route and method pair exactly once", () => {
  const ids = new Set<string>();
  const requests = new Set<string>();
  const registeredPaths = new Set<string>();

  for (const operation of ProtocolOperations) {
    assert.deepEqual(ProtocolOperationMetadataSchema.parse(operationMetadata(operation)), operationMetadata(operation));
    assert.equal(ids.has(operation.id), false, `duplicate operation id: ${operation.id}`);
    ids.add(operation.id);
    const requestKey = `${operation.method} ${operation.path}`;
    assert.equal(requests.has(requestKey), false, `duplicate protocol request: ${requestKey}`);
    requests.add(requestKey);
    registeredPaths.add(operation.path);
    assert.equal(findProtocolOperation(operation.method, operation.path), operation);
    assert.equal(protocolOperationById(operation.id), operation);
    assert(operation.limits.requestBytes > 0);
    assert(operation.limits.responseBytes > 0);
    assert(operation.limits.concurrency > 0);
  }

  assert.deepEqual([...registeredPaths].sort(), [...new Set(Object.values(ProtocolRoute))].sort());
  assert.deepEqual(protocolMethodsForPath(ProtocolRoute.CanonRelated).sort(), [ProtocolHttpMethod.Get, ProtocolHttpMethod.Post]);
  assert.deepEqual(protocolMethodsForPath(ProtocolRoute.Health), [ProtocolHttpMethod.Get]);
  assert.equal(findProtocolOperation(ProtocolHttpMethod.Post, ProtocolRoute.Health), undefined);
  assert.equal(protocolOperationById("health.read")?.authorization, ProtocolAuthorization.Public);
});

test("projection and event contracts expose revisions without embedding snapshots", () => {
  const ProjectionSchema = ProjectionResponseSchema(z.object({ id: z.string().min(1) }).strict());
  const projection = ProjectionSchema.parse({
    protocolVersion: DomainProtocolVersion,
    revision: 7,
    data: { id: "project" },
  });
  assert.equal(projection.revision, 7);

  const event = ProjectProtocolEventSchema.parse({
    protocolVersion: DomainProtocolVersion,
    sequence: 12,
    timestamp: "2026-07-16T08:00:00.000Z",
    revision: 7,
    domain: "canon",
    type: "published",
    summary: "Published Canon revision 7.",
    ids: ["service-boundary"],
  });
  assert.equal(event.sequence, 12);
  assert.throws(() => ProjectProtocolEventSchema.parse({ ...event, snapshot: { files: [] } }));
});

test("OpenAPI is deterministic and contains every registered operation", () => {
  const first = createOpenCanonOpenApiDocument();
  const second = createOpenCanonOpenApiDocument();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.openapi, "3.1.1");
  assert(first.components.schemas.OpenCanonFailure);

  for (const operation of ProtocolOperations) {
    const generated = first.paths[operation.path]?.[operation.method.toLowerCase()];
    assert(generated, `missing OpenAPI operation ${operation.id}`);
    assert.equal(generated.operationId, operation.id);
  }
});

test("the domain client derives versioned requests from operation ids", async () => {
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  const client = createDomainProtocolClient({
    transport: {
      async request(request) {
        requests.push(request);
        return {
          status: 200,
          statusText: "OK",
          body: {
            ok: true,
            data: {
              protocolVersion: DomainProtocolVersion,
              revision: 4,
              data: [{ id: "change-a" }],
            },
          },
        };
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
  });

  const result = await client.query<Array<{ id: string }>>("changes.list", {
    query: { status: ["ready", "running"], limit: "20" },
  });

  assert.deepEqual(result.data, [{ id: "change-a" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, ProtocolHttpMethod.Get);
  assert.equal(requests[0]?.path, "/api/changes?status=ready&status=running&limit=20");
  assert.equal(requests[0]?.headers[ProtocolHeader.Version], String(DomainProtocolVersion));
});

test("safe queries repair one typed transport failure and retry once", async () => {
  let attempts = 0;
  let repairs = 0;
  const client = createDomainProtocolClient({
    transport: {
      async request() {
        attempts += 1;
        if (attempts === 1) {
          throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Closed, "connection closed");
        }
        return {
          status: 200,
          statusText: "OK",
          body: {
            ok: true,
            data: { protocolVersion: DomainProtocolVersion, revision: 2, data: [] },
          },
        };
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
    async repair() {
      repairs += 1;
    },
  });

  await client.query("changes.list");
  assert.equal(attempts, 2);
  assert.equal(repairs, 1);
});

test("unsafe commands never replay after an ambiguous transport failure", async () => {
  let attempts = 0;
  let repairs = 0;
  const client = createDomainProtocolClient({
    transport: {
      async request() {
        attempts += 1;
        throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Closed, "connection closed");
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
    async repair() {
      repairs += 1;
    },
  });

  await assert.rejects(client.command("knowledge.index", { body: {} }), ProtocolTransportFailure);
  assert.equal(attempts, 1);
  assert.equal(repairs, 0);
});

test("keyed commands require and preserve their idempotency key across repair", async () => {
  const keys: Array<string | undefined> = [];
  let repairs = 0;
  const client = createDomainProtocolClient({
    transport: {
      async request(request) {
        keys.push(request.headers[ProtocolHeader.IdempotencyKey]);
        if (keys.length === 1) {
          throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Unavailable, "endpoint unavailable");
        }
        return { status: 200, statusText: "OK", body: { ok: true, data: { recorded: true } } };
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
    async repair() {
      repairs += 1;
    },
  });

  await assert.rejects(
    client.command("activity.record", { body: { id: "event-a" } }),
    /requires an idempotency key/,
  );
  assert.equal(keys.length, 0);

  const result = await client.command<{ recorded: boolean }>(
    "activity.record",
    { body: { id: "event-a" } },
    { idempotencyKey: "event-a" },
  );
  assert.deepEqual(result, { recorded: true });
  assert.deepEqual(keys, ["event-a", "event-a"]);
  assert.equal(repairs, 1);
});

test("domain failures and malformed success envelopes remain distinct", async () => {
  const responseFailureClient = createDomainProtocolClient({
    transport: {
      async request() {
        return {
          status: 409,
          statusText: "Conflict",
          body: createOpenCanonProblemFailure(createOpenCanonProblem({
            code: OpenCanonProblemCode.Unknown,
            title: "Conflict",
            detail: "The request conflicts with current state.",
            source: OpenCanonProblemSource.Protocol,
            status: 409,
          })),
        };
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
  });
  await assert.rejects(responseFailureClient.query("changes.list"), ProtocolResponseFailure);

  const malformedClient = createDomainProtocolClient({
    transport: {
      async request() {
        return { status: 200, statusText: "OK", body: { changes: [] } };
      },
      async stream() {
        throw new Error("stream was not expected");
      },
    },
  });
  await assert.rejects(malformedClient.query("changes.list"), (error: unknown) =>
    error instanceof ProtocolTransportFailure && error.code === ProtocolTransportFailureCode.Malformed);
});
