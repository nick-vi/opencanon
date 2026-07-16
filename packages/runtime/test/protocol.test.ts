import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import {
  DomainProtocolVersion,
  ProjectProtocolEventSchema,
  ProjectionResponseSchema,
  ProtocolAuthorization,
  ProtocolHttpMethod,
  ProtocolOperationMetadataSchema,
  ProtocolOperations,
  ProtocolRoute,
  createOpenCanonOpenApiDocument,
  findProtocolOperation,
  operationMetadata,
  protocolMethodsForPath,
  protocolOperationById,
} from "@opencanon/core";
import { validateMethod, validateRuntimeAuth } from "../src/routes.ts";

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

test("runtime method and authorization checks are derived from protocol policy", () => {
  assert.equal(validateMethod(ProtocolRoute.CanonRelated, ProtocolHttpMethod.Get).ok, true);
  assert.equal(validateMethod(ProtocolRoute.CanonRelated, ProtocolHttpMethod.Post).ok, true);
  assert.equal(validateMethod(ProtocolRoute.Health, ProtocolHttpMethod.Post).ok, false);

  const healthUrl = new URL(`http://opencanon.runtime${ProtocolRoute.Health}`);
  assert.equal(validateRuntimeAuth(new Request(healthUrl), healthUrl, "secret").ok, true);
  const stateUrl = new URL(`http://opencanon.runtime${ProtocolRoute.State}`);
  assert.equal(validateRuntimeAuth(new Request(stateUrl), stateUrl, "secret").ok, false);
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
